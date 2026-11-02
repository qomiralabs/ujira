// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the database itself refuses about a token, whatever the code above it
// does: the closed scope list, the required expiry and the rotation lineage.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import type { CreatedPrincipal } from './repositories/entry-points.js';
import { entryPoints } from './repositories/entry-points.js';
import { apiTokens, projects, type NewApiToken } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const EXPIRES_AT = new Date('2100-01-01T00:00:00Z');

const ALL_SCOPES = [
  'payouts:read',
  'payouts:write',
  'approvals:write',
  'recipients:read',
  'recipients:write',
  'mandates:read',
  'mandates:write',
  'receipts:read',
  'webhooks:manage',
  'corridors:read',
];

let database: TestDatabase;
let db: Database;
let alpha: CreatedPrincipal;
let bravo: CreatedPrincipal;

function newToken(overrides: Partial<NewApiToken> = {}): NewApiToken {
  return {
    prefix: `ujk_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    secretSha256: Buffer.alloc(32, 1),
    scopes: ['payouts:read'],
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

async function principal(name: string): Promise<CreatedPrincipal> {
  return db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: name, ownerUserId: randomUUID() }),
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  alpha = await principal('alpha');
  bravo = await principal('bravo');
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('scopes', () => {
  it('an unknown scope is refused', async () => {
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            apiTokens.create(tx, newToken({ scopes: ['payouts:read', 'payouts:admin'] })),
          ),
      ),
    ).toBe('23514');
  });

  it('accepts every listed scope, all ten on one token', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken({ scopes: ALL_SCOPES })));
    expect(token.scopes).toEqual(ALL_SCOPES);
  });

  it('refuses a token with no scopes', async () => {
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) => apiTokens.create(tx, newToken({ scopes: [] }))),
      ),
    ).toBe('23514');
  });

  it('refuses more than ten scopes, even repeats of listed ones', async () => {
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            apiTokens.create(tx, newToken({ scopes: [...ALL_SCOPES, 'payouts:read'] })),
          ),
      ),
    ).toBe('23514');
  });

  it('has no default, so a write that names no scopes fails rather than storing none', async () => {
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) =>
          sql`
            insert into ujira.api_tokens (principal_id, project_id, prefix, secret_sha256, expires_at)
            values (
              ujira.current_principal_id(),
              ujira.current_project_id(),
              ${newToken().prefix},
              ${Buffer.alloc(32, 1)},
              ${EXPIRES_AT}
            )
          `.execute(tx),
        ),
      ),
    ).toBe('23502');
  });
});

describe('expiry', () => {
  it('null expires_at is refused', async () => {
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) =>
          sql`
            insert into ujira.api_tokens (principal_id, project_id, prefix, secret_sha256, scopes, expires_at)
            values (
              ujira.current_principal_id(),
              ujira.current_project_id(),
              ${newToken().prefix},
              ${Buffer.alloc(32, 1)},
              ${['payouts:read']},
              null
            )
          `.execute(tx),
        ),
      ),
    ).toBe('23502');
  });

  it('an existing token cannot have its expiry taken away', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            sql`update ujira.api_tokens set expires_at = null where id = ${token.id}`.execute(tx),
          ),
      ),
    ).toBe('23502');
  });

  it('reads back the expiry it was given', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(token.expiresAt).toEqual(EXPIRES_AT);
  });
});

describe('prefix', () => {
  it('still holds the format the API issues', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) =>
        apiTokens.create(tx, newToken({ prefix: 'ujk_live_abcdefghijklmnop' })),
      );
    expect(token.prefix).toBe('ujk_live_abcdefghijklmnop');
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) => apiTokens.create(tx, newToken({ prefix: 'has space here' }))),
      ),
    ).toBe('23514');
  });
});

describe('last used', () => {
  it('writes once, then not again for five minutes', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(token.lastUsedAt).toBeNull();
    const touch = async (): Promise<boolean> =>
      db.tenant(alpha).transaction(async (tx) => apiTokens.touchLastUsed(tx, token.id));
    expect(await touch()).toBe(true);
    expect(await touch()).toBe(false);
    const stamped = await db.tenant(alpha).transaction(async (tx) => apiTokens.get(tx, token.id));
    expect(stamped?.lastUsedAt).toBeInstanceOf(Date);

    // Six minutes on, as far as the row can tell.
    await db.tenant(alpha).transaction(async (tx) =>
      sql`
        update ujira.api_tokens set last_used_at = now() - interval '6 minutes'
         where id = ${token.id}
      `.execute(tx),
    );
    expect(await touch()).toBe(true);
  });

  it('can still be written on a token that has been revoked', async () => {
    const token = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    await db.tenant(alpha).transaction(async (tx) => apiTokens.revoke(tx, token.id));
    expect(
      await db.tenant(alpha).transaction(async (tx) => apiTokens.touchLastUsed(tx, token.id)),
    ).toBe(true);
  });
});

describe('rotation lineage', () => {
  it('records which token a rotated one came from', async () => {
    const first = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(first.rotatedFromId).toBeNull();
    const second = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.create(tx, newToken({ rotatedFromId: first.id })));
    expect(second.rotatedFromId).toBe(first.id);
    expect(
      (await db.tenant(alpha).transaction(async (tx) => apiTokens.get(tx, second.id)))
        ?.rotatedFromId,
    ).toBe(first.id);
  });

  it('refuses a parent that does not exist', async () => {
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            apiTokens.create(tx, newToken({ rotatedFromId: randomUUID() })),
          ),
      ),
    ).toBe('23503');
  });

  it('refuses a parent in another tenant', async () => {
    const other = await db
      .tenant(bravo)
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) => apiTokens.create(tx, newToken({ rotatedFromId: other.id }))),
      ),
    ).toBe('23503');
  });

  it('refuses a parent in another project of the same principal', async () => {
    const secondProject = await db
      .tenant(alpha)
      .transaction(async (tx) => projects.create(tx, { name: 'second' }));
    const parent = await db
      .tenant({ principalId: alpha.principalId, projectId: secondProject })
      .transaction(async (tx) => apiTokens.create(tx, newToken()));
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) => apiTokens.create(tx, newToken({ rotatedFromId: parent.id }))),
      ),
    ).toBe('23503');
  });
});
