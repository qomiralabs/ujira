// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The key lifecycle on the real tables, as the role the API runs as, with the real
// authenticator deciding whether a key still works.

import { randomUUID } from 'node:crypto';

import { apiTokens, audit, entryPoints } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { API_KEY_MAX_ACTIVE, createApiKeyEndpoints } from './api-key-service.js';
import type { Tenant } from './auth.js';
import { ApiError } from './errors.js';
import { memoryLogger } from './log.js';
import { databaseApiKeyRecords, databaseTokenStore } from './postgres-stores.js';
import { createTokenAuthenticator } from './token-auth.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

let database: TestDatabase;
let db: Database;

async function newTenant(): Promise<Tenant> {
  return db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Tenant',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 6);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

function endpoints() {
  return createApiKeyEndpoints({ records: databaseApiKeyRecords(db), environment: 'test' });
}

// With no cache, so each question goes to the row. How long the cache can hold an
// answer is its own test below.
async function works(key: string, at: Date, cacheTtlMs = 0): Promise<boolean> {
  const authenticate = createTokenAuthenticator({
    store: databaseTokenStore(db),
    securityEvents: () => Promise.resolve(),
    environment: 'test',
    embedOrigins: [],
    logger: memoryLogger(),
    now: () => at,
    cacheTtlMs,
  });
  const result = await authenticate(
    { authorization: `Bearer ${key}`, origin: null },
    { signal: AbortSignal.timeout(5000), correlationId: 'test' },
  );
  return result.ok;
}

function callerOf(tenant: Tenant) {
  return { tenant, actorId: randomUUID() };
}

async function newKey(tenant: Tenant, days = 90) {
  return endpoints().create(
    { name: 'Billing', scopes: ['payouts:read', 'receipts:read'], expiresInDays: days },
    callerOf(tenant),
  );
}

async function codeOfFailure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  throw new Error('it did not fail');
}

describe('rotating a key', () => {
  it('old key works for 24 hours then fails', async () => {
    const tenant = await newTenant();
    const old = await newKey(tenant);
    const rotatedAt = Date.now();
    const next = await endpoints().rotate(old.id, { overlapHours: 24 }, callerOf(tenant));

    expect(await works(old.key, new Date(rotatedAt + 23 * HOUR_MS))).toBe(true);
    expect(await works(next.key, new Date(rotatedAt + 23 * HOUR_MS))).toBe(true);
    expect(await works(old.key, new Date(rotatedAt + 25 * HOUR_MS))).toBe(false);
    expect(await works(next.key, new Date(rotatedAt + 25 * HOUR_MS))).toBe(true);
  });

  it('with no overlap, the old key stops now', async () => {
    const tenant = await newTenant();
    const old = await newKey(tenant);
    const next = await endpoints().rotate(old.id, { overlapHours: 0 }, callerOf(tenant));
    expect(await works(old.key, new Date(Date.now() + 1000))).toBe(false);
    expect(await works(next.key, new Date(Date.now() + 1000))).toBe(true);
  });

  it('keeps the name, the scopes and the lifetime, and records the lineage', async () => {
    const tenant = await newTenant();
    const old = await newKey(tenant, 90);
    const next = await endpoints().rotate(old.id, { overlapHours: 1 }, callerOf(tenant));
    expect(next.name).toBe('Billing');
    expect(next.scopes).toEqual(['payouts:read', 'receipts:read']);
    expect(next.rotatedFromId).toBe(old.id);
    expect(next.id).not.toBe(old.id);
    expect(next.key).not.toBe(old.key);
    const lifetime = new Date(next.expiresAt).getTime() - new Date(next.createdAt).getTime();
    expect(Math.abs(lifetime - 90 * DAY_MS)).toBeLessThan(60_000);
  });

  it('an overlap never keeps a key past the expiry it had', async () => {
    const tenant = await newTenant();
    const old = await newKey(tenant, 1);
    const next = await endpoints().rotate(old.id, { overlapHours: 168 }, callerOf(tenant));
    expect(next.previousKeyExpiresAt).toBe(old.expiresAt);
  });

  it('a key is rotated once', async () => {
    const tenant = await newTenant();
    const old = await newKey(tenant);
    await endpoints().rotate(old.id, { overlapHours: 24 }, callerOf(tenant));
    expect(
      await codeOfFailure(endpoints().rotate(old.id, { overlapHours: 24 }, callerOf(tenant))),
    ).toBe('API_KEY_NOT_ROTATABLE');
  });

  it('two rotations racing leave one successor', async () => {
    const tenant = await newTenant();
    const old = await newKey(tenant);
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => endpoints().rotate(old.id, { overlapHours: 24 }, callerOf(tenant))),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const keys = await db.tenant(tenant).transaction((tx) => apiTokens.list(tx, { limit: 100 }));
    expect(keys.items.filter((key) => key.rotatedFromId === old.id)).toHaveLength(1);
  });

  it('refuses a revoked key', async () => {
    const tenant = await newTenant();
    const old = await newKey(tenant);
    await endpoints().revoke(old.id, callerOf(tenant));
    expect(
      await codeOfFailure(endpoints().rotate(old.id, { overlapHours: 1 }, callerOf(tenant))),
    ).toBe('API_KEY_NOT_ROTATABLE');
  });

  it("another principal's key is 404, and nothing happens to it", async () => {
    const owner = await newTenant();
    const other = await newTenant();
    const old = await newKey(owner);
    expect(
      await codeOfFailure(endpoints().rotate(old.id, { overlapHours: 0 }, callerOf(other))),
    ).toBe('NOT_FOUND');
    expect(await works(old.key, new Date())).toBe(true);
  });

  it('writes who did it to the audit log, and nothing of the key but its id', async () => {
    const tenant = await newTenant();
    const caller = callerOf(tenant);
    const old = await endpoints().create(
      { name: 'Billing', preset: 'full', expiresInDays: 30 },
      caller,
    );
    await endpoints().rotate(old.id, { overlapHours: 1 }, caller);
    await endpoints().revoke(old.id, caller);
    const page = await db.tenant(tenant).transaction((tx) => audit.list(tx, { limit: 100 }));
    const entries = page.items.filter((entry) => entry.action.startsWith('api_key.'));
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'api_key.created',
      'api_key.revoked',
      'api_key.rotated',
    ]);
    for (const entry of entries) {
      expect(entry.actorId).toBe(caller.actorId);
      expect(entry.metadata).toEqual({ target_type: 'api_key', target_id: old.id });
    }
  });
});

describe('revoking a key', () => {
  it('stops it, and a second revoke says the same', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant);
    const first = await endpoints().revoke(key.id, callerOf(tenant));
    expect(first.revokedAt).not.toBeNull();
    expect(await works(key.key, new Date())).toBe(false);
    const second = await endpoints().revoke(key.id, callerOf(tenant));
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('applies within the 30 second cache', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant);
    let at = new Date();
    const authenticate = createTokenAuthenticator({
      store: databaseTokenStore(db),
      securityEvents: () => Promise.resolve(),
      environment: 'test',
      embedOrigins: [],
      logger: memoryLogger(),
      now: () => at,
    });
    const check = async (): Promise<boolean> =>
      (
        await authenticate(
          { authorization: `Bearer ${key.key}`, origin: null },
          { signal: AbortSignal.timeout(5000), correlationId: 'test' },
        )
      ).ok;
    expect(await check()).toBe(true);
    await endpoints().revoke(key.id, callerOf(tenant));
    at = new Date(at.getTime() + 31_000);
    expect(await check()).toBe(false);
  });

  it("another principal's key is 404, and it keeps working", async () => {
    const owner = await newTenant();
    const other = await newTenant();
    const key = await newKey(owner);
    expect(await codeOfFailure(endpoints().revoke(key.id, callerOf(other)))).toBe('NOT_FOUND');
    expect(await works(key.key, new Date())).toBe(true);
  });
});

describe('the limit on active keys', () => {
  const fill = async (tenant: Tenant, count: number) => {
    const keys = [];
    for (let at = 0; at < count; at += 1) keys.push(await newKey(tenant));
    return keys;
  };

  it('holds a project to 20, and frees a slot on revoke', async () => {
    const tenant = await newTenant();
    const keys = await fill(tenant, API_KEY_MAX_ACTIVE);
    expect(await codeOfFailure(newKey(tenant))).toBe('API_KEY_LIMIT_REACHED');
    const first = keys[0];
    if (first === undefined) throw new Error('no keys were made');
    await endpoints().revoke(first.id, callerOf(tenant));
    await expect(newKey(tenant)).resolves.toBeDefined();
  });

  it('rotating still works at the limit', async () => {
    const tenant = await newTenant();
    const keys = await fill(tenant, API_KEY_MAX_ACTIVE);
    const first = keys[0];
    if (first === undefined) throw new Error('no keys were made');
    await expect(
      endpoints().rotate(first.id, { overlapHours: 24 }, callerOf(tenant)),
    ).resolves.toBeDefined();
    expect(await codeOfFailure(newKey(tenant))).toBe('API_KEY_LIMIT_REACHED');
  });

  it('a key in its overlap and its successor count as one', async () => {
    const tenant = await newTenant();
    const [rotated, revoked] = await fill(tenant, API_KEY_MAX_ACTIVE);
    if (rotated === undefined || revoked === undefined) throw new Error('no keys were made');
    await endpoints().rotate(rotated.id, { overlapHours: 24 }, callerOf(tenant));
    // Still 20 in use, so giving one up leaves room for exactly one more. Were the
    // old key counted as well, that would still be 20 and refused.
    await endpoints().revoke(revoked.id, callerOf(tenant));
    await expect(newKey(tenant)).resolves.toBeDefined();
    expect(await codeOfFailure(newKey(tenant))).toBe('API_KEY_LIMIT_REACHED');
  });

  it('two creates racing for the last slot get one key', async () => {
    const tenant = await newTenant();
    await fill(tenant, API_KEY_MAX_ACTIVE - 1);
    const results = await Promise.allSettled([newKey(tenant), newKey(tenant), newKey(tenant)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('counts one project only', async () => {
    const full = await newTenant();
    await fill(full, API_KEY_MAX_ACTIVE);
    const other = await newTenant();
    await expect(newKey(other)).resolves.toBeDefined();
  });
});
