// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The authenticator against the real table, through the role the API runs as,
// so the prefix lookup, the row level security and the closed scope list are the
// real ones rather than a fake's idea of them.

import { randomUUID } from 'node:crypto';

import { apiTokens, entryPoints } from '@ujira/db';
import type { Database, NewApiToken } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import { API_SCOPES } from './auth.js';
import type { Tenant } from './auth.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { databaseSecurityEvents, databaseTokenStore } from './postgres-stores.js';
import { allowEveryRequest } from './rate-limit.js';
import { defineTenantRoute } from './route.js';
import { issueToken } from './token.js';
import { createTokenAuthenticator } from './token-auth.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const FUTURE = new Date('2100-01-01T00:00:00Z');

let database: TestDatabase;
let db: Database;

const Whoami = z.strictObject({ principalId: z.string(), projectId: z.string() });

const whoami = defineTenantRoute({
  id: 'whoami',
  method: 'GET',
  path: '/v1/whoami',
  summary: 'Who is calling',
  scope: 'payouts:read',
  response: { name: 'Whoami', schema: Whoami },
  handler: (_input, context) => Promise.resolve({ ...context.tenant }),
});

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

async function newTenant(): Promise<Tenant> {
  return db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Tenant',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
}

async function newKey(tenant: Tenant, overrides: Partial<NewApiToken> = {}) {
  const issued = issueToken('test');
  const row = await db.tenant(tenant).transaction((tx) =>
    apiTokens.create(tx, {
      prefix: issued.prefix,
      secretSha256: issued.secretSha256,
      scopes: ['payouts:read'],
      expiresAt: FUTURE,
      ...overrides,
    }),
  );
  return { ...issued, id: row.id };
}

function served(now?: () => Date) {
  const logger = memoryLogger();
  const app = createApp({
    routes: [whoami],
    authenticate: createTokenAuthenticator({
      store: databaseTokenStore(db),
      securityEvents: databaseSecurityEvents(db),
      environment: 'test',
      embedOrigins: [],
      logger,
      // No cache, so each request here shows what the table says now.
      cacheTtlMs: 0,
      ...(now === undefined ? {} : { now }),
    }),
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    logger,
  });
  const call = (token: string) =>
    app.request('/v1/whoami', { headers: { authorization: `Bearer ${token}` } });
  return Object.assign(call, { logger });
}

describe('against the table', () => {
  it('finds the tenant from the key alone', async () => {
    const alpha = await newTenant();
    const bravo = await newTenant();
    const call = served();
    const alphaKey = await newKey(alpha);
    const bravoKey = await newKey(bravo);
    expect(await (await call(alphaKey.token)).json()).toEqual({
      principalId: alpha.principalId,
      projectId: alpha.projectId,
    });
    expect(await (await call(bravoKey.token)).json()).toEqual({
      principalId: bravo.principalId,
      projectId: bravo.projectId,
    });
  });

  it('refuses an unknown key, a revoked key and an expired key', async () => {
    const tenant = await newTenant();
    const call = served();
    const unknown = issueToken('test');
    expect((await call(unknown.token)).status).toBe(401);

    const revoked = await newKey(tenant);
    expect((await call(revoked.token)).status).toBe(200);
    await db.tenant(tenant).transaction((tx) => apiTokens.revoke(tx, revoked.id));
    expect((await call(revoked.token)).status).toBe(401);

    const expired = await newKey(tenant, { expiresAt: new Date(Date.now() - 1000) });
    expect((await call(expired.token)).status).toBe(401);
  });

  it('records a refused key through the real function, as the role the API runs as', async () => {
    const call = served();
    expect((await call(issueToken('test').token)).status).toBe(401);
    expect(call.logger.records.map((r) => r.event)).not.toContain('security_event_failed');
  });

  it('holds only the hash of the secret', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant);
    const found = await db.unscoped((tx) => entryPoints.authenticateToken(tx, key.prefix));
    expect(found?.secretSha256).toEqual(key.secretSha256);
    const secret = key.token.slice(key.prefix.length + 1, -7);
    expect(found?.secretSha256.toString('utf8')).not.toContain(secret);
  });

  it('the database accepts each scope in the API list and nothing else', async () => {
    const tenant = await newTenant();
    const everyScope = await newKey(tenant, { scopes: API_SCOPES });
    const page = await db.tenant(tenant).transaction((tx) => apiTokens.get(tx, everyScope.id));
    expect(page?.scopes).toEqual([...API_SCOPES]);
    await expect(newKey(tenant, { scopes: ['payouts:admin'] })).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('last used', () => {
  async function lastUsedOf(tenant: Tenant, id: string): Promise<Date | null | undefined> {
    return (await db.tenant(tenant).transaction((tx) => apiTokens.get(tx, id)))?.lastUsedAt;
  }

  it('starts empty and is set by the first use', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant);
    expect(await lastUsedOf(tenant, key.id)).toBeNull();
    await served()(key.token);
    expect(await lastUsedOf(tenant, key.id)).toBeInstanceOf(Date);
  });

  it('is written at most once per five minutes, however many instances use the key', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant);
    await served()(key.token);
    const firstUse = await lastUsedOf(tenant, key.id);
    await served()(key.token);
    await served()(key.token);
    expect(await lastUsedOf(tenant, key.id)).toEqual(firstUse);
  });
});
