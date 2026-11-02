// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { CreatedPrincipal } from './repositories/entry-points.js';
import type { Database } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { apiTokens } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let alpha: CreatedPrincipal;
let bravo: CreatedPrincipal;

async function principal(name: string): Promise<CreatedPrincipal> {
  return db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: name, ownerUserId: randomUUID() }),
  );
}

function prefix(): string {
  return `uj_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

describe('api tokens', () => {
  it('authenticate_token returns one row for its prefix only', async () => {
    const secret = createHash('sha256').update('alpha secret').digest();
    const alphaPrefix = prefix();
    const created = await db.tenant(alpha).transaction(async (tx) =>
      apiTokens.create(tx, {
        prefix: alphaPrefix,
        secretSha256: secret,
        scopes: ['payouts:write'],
        expiresAt: null,
      }),
    );
    const bravoPrefix = prefix();
    await db.tenant(bravo).transaction(async (tx) =>
      apiTokens.create(tx, {
        prefix: bravoPrefix,
        secretSha256: Buffer.alloc(32, 1),
        scopes: [],
        expiresAt: null,
      }),
    );

    const found = await db.unscoped(async (tx) => entryPoints.authenticateToken(tx, alphaPrefix));
    expect(found).toEqual({
      tokenId: created.id,
      principalId: alpha.principalId,
      projectId: alpha.projectId,
      secretSha256: secret,
      scopes: ['payouts:write'],
      expiresAt: null,
      revokedAt: null,
    });
    expect(
      (await db.unscoped(async (tx) => entryPoints.authenticateToken(tx, bravoPrefix)))
        ?.principalId,
    ).toBe(bravo.principalId);
    expect(
      await db.unscoped(async (tx) => entryPoints.authenticateToken(tx, prefix())),
    ).toBeUndefined();
    // The function is the only way to the table without a context.
    expect(
      await codeOf(
        db.unscoped(async (tx) => sql`select count(*) from ujira.api_tokens`.execute(tx)),
      ),
    ).toBe('UJ001');
  });

  it('keeps every prefix unique across tenants', async () => {
    const shared = prefix();
    const input = {
      prefix: shared,
      secretSha256: Buffer.alloc(32, 2),
      scopes: [],
      expiresAt: null,
    };
    await db.tenant(alpha).transaction(async (tx) => apiTokens.create(tx, input));
    expect(
      await codeOf(db.tenant(bravo).transaction(async (tx) => apiTokens.create(tx, input))),
    ).toBe('23505');
  });

  it('stores only a 32 byte hash of the secret', async () => {
    expect(
      await codeOf(
        db.tenant(alpha).transaction(async (tx) =>
          apiTokens.create(tx, {
            prefix: prefix(),
            secretSha256: Buffer.alloc(31, 3),
            scopes: [],
            expiresAt: null,
          }),
        ),
      ),
    ).toBe('23514');
  });

  it('keeps a revoked token revoked', async () => {
    const token = await db.tenant(alpha).transaction(async (tx) =>
      apiTokens.create(tx, {
        prefix: prefix(),
        secretSha256: Buffer.alloc(32, 4),
        scopes: [],
        expiresAt: null,
      }),
    );
    expect(await db.tenant(alpha).transaction(async (tx) => apiTokens.revoke(tx, token.id))).toBe(
      true,
    );
    // Already revoked: nothing left to revoke.
    expect(await db.tenant(alpha).transaction(async (tx) => apiTokens.revoke(tx, token.id))).toBe(
      false,
    );
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            sql`update ujira.api_tokens set revoked_at = null where id = ${token.id}`.execute(tx),
          ),
      ),
    ).toBe('UJ006');
    expect(
      await codeOf(
        db
          .tenant(alpha)
          .transaction(async (tx) =>
            sql`update ujira.api_tokens set prefix = ${prefix()} where id = ${token.id}`.execute(
              tx,
            ),
          ),
      ),
    ).toBe('UJ006');
    const page = await db
      .tenant(alpha)
      .transaction(async (tx) => apiTokens.list(tx, { limit: 100 }));
    expect(page.items.find((item) => item.id === token.id)?.revokedAt).toBeInstanceOf(Date);
  });
});
