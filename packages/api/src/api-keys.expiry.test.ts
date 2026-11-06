// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The expiry warnings on the real tables. Time passes by bringing a key's expiry
// forward, since the sweep asks the database what is due.

import { randomUUID } from 'node:crypto';

import { apiTokens, entryPoints } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createApiKeyEndpoints } from './api-key-service.js';
import { sendApiKeyExpiryWarnings } from './api-key-warnings.js';
import type { ApiKeyExpiryWarning } from './api-key-warnings.js';
import type { Tenant } from './auth.js';
import { memoryLogger } from './log.js';
import { databaseApiKeyRecords, databaseApiKeyWarningRecords } from './postgres-stores.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
const made: { readonly tenant: Tenant; readonly id: string }[] = [];

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
  db = databaseAsServiceRoles(roleUrls, database, 4);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

// A test sees only what it made: the sweep looks across every tenant, so each test
// starts with no key left in a window from the one before.
beforeEach(async () => {
  for (const { tenant, id } of made.splice(0)) {
    await db.tenant(tenant).transaction((tx) => apiTokens.revoke(tx, id));
  }
});

function endpoints() {
  return createApiKeyEndpoints({ records: databaseApiKeyRecords(db), environment: 'test' });
}

async function newKey(tenant: Tenant, days: number) {
  const key = await endpoints().create(
    { name: 'Billing', preset: 'read_only', expiresInDays: days },
    { tenant, actorId: randomUUID() },
  );
  made.push({ tenant, id: key.id });
  return key;
}

async function bringExpiryForward(tenant: Tenant, id: string, days: number): Promise<void> {
  const at = new Date(Date.now() + days * 86_400_000);
  await db.tenant(tenant).transaction((tx) => apiTokens.shortenExpiry(tx, id, at));
}

function sweep(
  notify: (warning: ApiKeyExpiryWarning) => void | Promise<void>,
  claimSeconds?: number,
) {
  const logger = memoryLogger();
  return {
    logger,
    run: () =>
      sendApiKeyExpiryWarnings({
        records: databaseApiKeyWarningRecords(db),
        notify: async (warning) => {
          await notify(warning);
        },
        logger,
        ...(claimSeconds === undefined ? {} : { claimSeconds }),
      }),
  };
}

describe('expiry warnings', () => {
  it('30 and 7 day warnings are emitted once each', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant, 90);
    const sent: ApiKeyExpiryWarning[] = [];
    const { run } = sweep((warning) => {
      sent.push(warning);
    });

    await run();
    expect(sent).toHaveLength(0);

    await bringExpiryForward(tenant, key.id, 29);
    await run();
    await run();
    expect(sent.map((warning) => warning.thresholdDays)).toEqual([30]);

    await bringExpiryForward(tenant, key.id, 6);
    await run();
    await run();
    expect(sent.map((warning) => warning.thresholdDays)).toEqual([30, 7]);
    expect(sent[1]).toMatchObject({
      tokenId: key.id,
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      prefix: key.prefix,
      name: 'Billing',
    });
  });

  it('a key made inside both windows gets the 7 day warning alone', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant, 5);
    const sent: ApiKeyExpiryWarning[] = [];
    const { run } = sweep((warning) => {
      sent.push(warning);
    });
    await run();
    await run();
    expect(sent.map((warning) => [warning.tokenId, warning.thresholdDays])).toEqual([[key.id, 7]]);
  });

  it('holds nothing of the secret', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant, 5);
    const sent: ApiKeyExpiryWarning[] = [];
    await sweep((warning) => {
      sent.push(warning);
    }).run();
    expect(JSON.stringify(sent)).not.toContain(key.key);
  });

  it('does not warn about a revoked, rotated or expired key', async () => {
    const tenant = await newTenant();
    const caller = { tenant, actorId: randomUUID() };
    const revoked = await newKey(tenant, 5);
    await endpoints().revoke(revoked.id, caller);
    const rotated = await newKey(tenant, 90);
    const successor = await endpoints().rotate(rotated.id, { overlapHours: 24 }, caller);
    const expired = await newKey(tenant, 5);
    await bringExpiryForward(tenant, expired.id, -1);

    const sent: ApiKeyExpiryWarning[] = [];
    await sweep((warning) => {
      sent.push(warning);
    }).run();
    expect(sent).toHaveLength(0);
    expect(successor.id).not.toBe(rotated.id);
  });

  it('warns each tenant under its own tenant', async () => {
    const alpha = await newTenant();
    const bravo = await newTenant();
    const alphaKey = await newKey(alpha, 5);
    const bravoKey = await newKey(bravo, 5);
    const sent: ApiKeyExpiryWarning[] = [];
    await sweep((warning) => {
      sent.push(warning);
    }).run();
    expect(sent).toHaveLength(2);
    expect(sent.find((warning) => warning.tokenId === alphaKey.id)?.principalId).toBe(
      alpha.principalId,
    );
    expect(sent.find((warning) => warning.tokenId === bravoKey.id)?.principalId).toBe(
      bravo.principalId,
    );
  });

  it('two sweeps at once send one warning', async () => {
    const tenant = await newTenant();
    await newKey(tenant, 5);
    const sent: ApiKeyExpiryWarning[] = [];
    const { run } = sweep((warning) => {
      sent.push(warning);
    });
    await Promise.all([run(), run(), run()]);
    expect(sent).toHaveLength(1);
  });

  it('a failed send is logged, holds up nobody else, and is tried again', async () => {
    const tenant = await newTenant();
    const failing = await newKey(tenant, 5);
    const fine = await newKey(tenant, 5);
    const sent: string[] = [];
    const first = sweep((warning) => {
      if (warning.tokenId === failing.id) throw new TypeError('the mail provider is down');
      sent.push(warning.tokenId);
    });
    expect(await first.run()).toEqual({ sent: 1, failed: 1 });
    expect(sent).toEqual([fine.id]);
    expect(first.logger.records).toMatchObject([
      { event: 'api_key_warning_failed', errorName: 'TypeError', resourceId: failing.id },
    ]);
    // Nothing of the failure's text reaches the log.
    expect(JSON.stringify(first.logger.records)).not.toContain('mail provider');

    const retried = sweep((warning) => {
      sent.push(warning.tokenId);
    });
    // Its claim still stands, so the next sweep leaves it alone.
    await retried.run();
    expect(sent).toEqual([fine.id]);

    // Once it has run out, the next sweep takes it over.
    await sweep((warning) => {
      sent.push(warning.tokenId);
    }, 0).run();
    expect(sent).toEqual([fine.id, failing.id]);
  });

  it('a process dying after it sends repeats the warning, and never loses it', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant, 5);
    const records = databaseApiKeyWarningRecords(db);
    const logger = memoryLogger();
    const sent: string[] = [];
    await expect(
      sendApiKeyExpiryWarnings({
        records: {
          ...records,
          markNotified: () => Promise.reject(new Error('the process died here')),
        },
        notify: (warning) => {
          sent.push(warning.tokenId);
          return Promise.resolve();
        },
        logger,
      }),
    ).rejects.toThrow();
    await sweep((warning) => {
      sent.push(warning.tokenId);
    }, 0).run();
    expect(sent).toEqual([key.id, key.id]);
  });

  it('the cross tenant read gives ids and nothing of the key', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant, 5);
    const targets = await db.unscoped((tx) =>
      entryPoints.apiTokensNearingExpiry(tx, undefined, 100),
    );
    expect(targets).toContainEqual({
      tokenId: key.id,
      principalId: tenant.principalId,
      projectId: tenant.projectId,
    });
    const stored = await db.tenant(tenant).transaction((tx) => apiTokens.get(tx, key.id));
    expect(stored?.name).toBe('Billing');
  });
});
