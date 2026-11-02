// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The cross-tenant matrix. Two principals with two projects each. Every
// repository method runs as tenant A against tenant B's ids and must find
// nothing, return a page without B's rows, or land its write in A.

import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database, ProjectContext } from './database.js';
import type { Schema } from './schema.generated.js';
import { entryPoints } from './repositories/entry-points.js';
import {
  apiTokens,
  members,
  principals,
  projects,
  tenancyRepositories,
} from './repositories/tenancy.js';
import { caseProblems, methodNames } from './testing/cross-tenant.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

interface Tenant {
  readonly first: ProjectContext;
  readonly second: ProjectContext;
  readonly ownerUserId: string;
  readonly tokenId: string;
}

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let a: Tenant;
let b: Tenant;

async function tenant(name: string): Promise<Tenant> {
  const ownerUserId = randomUUID();
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: `${name} one`, ownerUserId }),
  );
  const first = { principalId: created.principalId, projectId: created.projectId };
  const secondId = await db
    .tenant(first)
    .transaction(async (tx) => projects.create(tx, { name: `${name} two` }));
  const token = await db.tenant(first).transaction(async (tx) =>
    apiTokens.create(tx, {
      prefix: `uj_${name}_${randomUUID().slice(0, 8)}`,
      secretSha256: Buffer.alloc(32, 7),
      scopes: ['payouts:read'],
      expiresAt: null,
    }),
  );
  return {
    first,
    second: { principalId: created.principalId, projectId: secondId },
    ownerUserId,
    tokenId: token.id,
  };
}

async function ownerOf(table: string, column: string, value: string): Promise<string | undefined> {
  const result = await admin.query<{ principal_id: string }>(
    `select principal_id from ${table} where ${column} = $1`,
    [value],
  );
  return result.rows[0]?.principal_id;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  a = await tenant('alpha');
  b = await tenant('bravo');
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

// Tenant A's first project, and every project of A read only.
const asA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.tenant(a.first).transaction(work);
const acrossA = async <T>(work: (tx: Kysely<Schema>) => Promise<T>): Promise<T> =>
  db.principal(a.first, 'app').transaction(work);

// One case per repository method, each run as tenant A.
const cases: Record<string, () => Promise<void>> = {
  'principals.current': async () => {
    const found = await asA(async (tx) => principals.current(tx));
    expect(found?.id).toBe(a.first.principalId);
  },
  'principals.get': async () => {
    expect(await asA(async (tx) => principals.get(tx, b.first.principalId))).toBeUndefined();
  },
  'principals.setReportingTimeZone': async () => {
    expect(
      await asA(async (tx) =>
        principals.setReportingTimeZone(tx, b.first.principalId, 'Africa/Lagos'),
      ),
    ).toBe(false);
  },
  'projects.list': async () => {
    // Other cases may have added projects to A; none may belong to B.
    const page = await acrossA(async (tx) => projects.list(tx, { limit: 100 }));
    const ids = page.items.map((project) => project.id);
    expect(ids).toEqual(expect.arrayContaining([a.first.projectId, a.second.projectId]));
    expect(ids).not.toContain(b.first.projectId);
    expect(ids).not.toContain(b.second.projectId);
    expect(new Set(page.items.map((project) => project.principalId))).toEqual(
      new Set([a.first.principalId]),
    );
  },
  'projects.get': async () => {
    expect(await acrossA(async (tx) => projects.get(tx, b.first.projectId))).toBeUndefined();
  },
  'projects.create': async () => {
    const id = await asA(async (tx) => projects.create(tx, { name: 'made by a' }));
    expect(await ownerOf('ujira.projects', 'id', id)).toBe(a.first.principalId);
  },
  'projects.rename': async () => {
    expect(await asA(async (tx) => projects.rename(tx, b.first.projectId, 'taken'))).toBe(false);
  },
  'members.list': async () => {
    const page = await asA(async (tx) => members.list(tx, { limit: 100 }));
    expect(page.items.map((member) => member.userId)).not.toContain(b.ownerUserId);
    expect(page.items.map((member) => member.userId)).toContain(a.ownerUserId);
  },
  'members.get': async () => {
    expect(await asA(async (tx) => members.get(tx, b.ownerUserId))).toBeUndefined();
  },
  'members.add': async () => {
    const userId = randomUUID();
    await asA(async (tx) => members.add(tx, { userId, role: 'viewer' }));
    expect(await ownerOf('ujira.principal_members', 'user_id', userId)).toBe(a.first.principalId);
  },
  'members.changeRole': async () => {
    expect(await asA(async (tx) => members.changeRole(tx, b.ownerUserId, 'viewer'))).toBe(false);
  },
  'apiTokens.list': async () => {
    const page = await acrossA(async (tx) => apiTokens.list(tx, { limit: 100 }));
    expect(page.items.map((token) => token.id)).not.toContain(b.tokenId);
    expect(page.items.map((token) => token.id)).toContain(a.tokenId);
  },
  'apiTokens.get': async () => {
    expect(await acrossA(async (tx) => apiTokens.get(tx, b.tokenId))).toBeUndefined();
  },
  'apiTokens.create': async () => {
    const token = await asA(async (tx) =>
      apiTokens.create(tx, {
        prefix: `uj_case_${randomUUID().slice(0, 8)}`,
        secretSha256: Buffer.alloc(32, 9),
        scopes: [],
        expiresAt: null,
      }),
    );
    expect(token.projectId).toBe(a.first.projectId);
    expect(await ownerOf('ujira.api_tokens', 'id', token.id)).toBe(a.first.principalId);
  },
  'apiTokens.revoke': async () => {
    expect(await asA(async (tx) => apiTokens.revoke(tx, b.tokenId))).toBe(false);
    const bToken = await admin.query<{ revoked_at: Date | null }>(
      'select revoked_at from ujira.api_tokens where id = $1',
      [b.tokenId],
    );
    expect(bToken.rows[0]?.revoked_at).toBeNull();
  },
};

describe('cross-tenant matrix', () => {
  it('has a case for every repository method, and none for a method that does not exist', () => {
    expect(caseProblems(tenancyRepositories, Object.keys(cases))).toEqual([]);
  });

  it('fails when a method is added without a case', () => {
    const grown = {
      ...tenancyRepositories,
      ledger: { post: () => undefined, note: 'not a method' },
    };
    expect(caseProblems(grown, Object.keys(cases))).toEqual([
      'ledger.post has no cross-tenant case',
    ]);
    expect(caseProblems(tenancyRepositories, [...Object.keys(cases), 'projects.delete'])).toEqual([
      'projects.delete is not a repository method',
    ]);
  });

  it.each(methodNames(tenancyRepositories))('%s cannot reach the other tenant', async (name) => {
    const run = cases[name];
    expect(run, name).toBeDefined();
    await run?.();
  });
});
