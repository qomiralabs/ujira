// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { PageRequestError } from './repositories/page.js';
import { members, principals, projects } from './repositories/tenancy.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function counts(): Promise<Record<string, string>> {
  const result = await admin.query<{ principals: string; projects: string; members: string }>(
    `select (select count(*) from ujira.principals)::text as principals,
            (select count(*) from ujira.projects)::text as projects,
            (select count(*) from ujira.principal_members)::text as members`,
  );
  return result.rows[0] ?? {};
}

async function create(overrides: { projectName?: string; reportingTimeZone?: string } = {}) {
  return db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: overrides.projectName ?? 'Main',
      ownerUserId: randomUUID(),
      ...(overrides.reportingTimeZone === undefined
        ? {}
        : { reportingTimeZone: overrides.reportingTimeZone }),
    }),
  );
}

describe('principals', () => {
  it('reporting_time_zone defaults to UTC, accepts Africa/Lagos and refuses Mars/Olympus', async () => {
    const created = await create();
    const session = db.tenant(created);
    expect(
      (await session.transaction(async (tx) => principals.current(tx)))?.reportingTimeZone,
    ).toBe('UTC');
    expect(
      await session.transaction(async (tx) =>
        principals.setReportingTimeZone(tx, created.principalId, 'Africa/Lagos'),
      ),
    ).toBe(true);
    expect(
      (await session.transaction(async (tx) => principals.current(tx)))?.reportingTimeZone,
    ).toBe('Africa/Lagos');
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          principals.setReportingTimeZone(tx, created.principalId, 'Mars/Olympus'),
        ),
      ),
    ).toBe('22023');
    expect(await codeOf(create({ reportingTimeZone: 'Mars/Olympus' }))).toBe('22023');
  });

  it('create_principal writes principal, project and owner member or nothing', async () => {
    const before = await counts();
    const created = await create();
    const after = await counts();
    expect(Number(after['principals'])).toBe(Number(before['principals']) + 1);
    expect(Number(after['projects'])).toBe(Number(before['projects']) + 1);
    expect(Number(after['members'])).toBe(Number(before['members']) + 1);
    const owner = await admin.query<{ role: string }>(
      'select role from ujira.principal_members where principal_id = $1',
      [created.principalId],
    );
    expect(owner.rows).toEqual([{ role: 'owner' }]);

    // The project insert fails after the principal insert succeeded; the
    // principal must not survive it.
    const middle = await counts();
    expect(await codeOf(create({ projectName: '' }))).toBe('23514');
    expect(await counts()).toEqual(middle);
    // And a failure in the first insert leaves nothing either.
    expect(await codeOf(create({ reportingTimeZone: 'Mars/Olympus' }))).toBe('22023');
    expect(await counts()).toEqual(middle);
  });

  it('runs nothing but the entry points without a tenant context', async () => {
    expect(await codeOf(db.unscoped(async (tx) => principals.current(tx)))).toBe('UJ001');
    expect(await codeOf(db.unscoped(async (tx) => projects.list(tx, { limit: 10 })))).toBe('UJ001');
  });
});

describe('projects', () => {
  it('creates projects for its principal, renames its own, and pages through them all under scope all', async () => {
    const created = await create();
    const session = db.tenant(created);
    const second = await session.transaction(async (tx) => projects.create(tx, { name: 'Second' }));
    await session.transaction(async (tx) => projects.create(tx, { name: 'Third' }));
    expect(
      await session.transaction(async (tx) => projects.rename(tx, created.projectId, 'Renamed')),
    ).toBe(true);
    // Project scope sees its own project only, so another of its projects
    // cannot be renamed from here.
    expect(await session.transaction(async (tx) => projects.rename(tx, second, 'Nope'))).toBe(
      false,
    );
    expect(
      (await session.transaction(async (tx) => projects.get(tx, created.projectId)))?.name,
    ).toBe('Renamed');

    const across = db.principal(created, 'app');
    const first = await across.transaction(async (tx) => projects.list(tx, { limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const after = first.next;
    if (after === null) throw new Error('expected a second page');
    const rest = await across.transaction(async (tx) => projects.list(tx, { limit: 2, after }));
    expect(rest.items).toHaveLength(1);
    expect(rest.next).toBeNull();
    const all = [...first.items, ...rest.items];
    expect(new Set(all.map((project) => project.principalId))).toEqual(
      new Set([created.principalId]),
    );
  });

  it('cannot create anything under scope all', async () => {
    const created = await create();
    expect(
      await codeOf(
        db.principal(created, 'app').transaction(async (tx) => projects.create(tx, { name: 'x' })),
      ),
    ).toBe('25006');
  });

  it('refuses a page size outside 1 to 100', async () => {
    const created = await create();
    for (const limit of [0, 101, 1.5]) {
      await expect(
        db.tenant(created).transaction(async (tx) => projects.list(tx, { limit })),
      ).rejects.toThrow(PageRequestError);
    }
  });
});

describe('members', () => {
  it('lists the owner, adds a member, changes a role and refuses a role it does not know', async () => {
    const created = await create();
    const session = db.tenant(created);
    const userId = randomUUID();
    const added = await session.transaction(async (tx) =>
      members.add(tx, { userId, role: 'developer' }),
    );
    expect(added.role).toBe('developer');
    expect(await session.transaction(async (tx) => members.changeRole(tx, userId, 'admin'))).toBe(
      true,
    );
    expect((await session.transaction(async (tx) => members.get(tx, userId)))?.role).toBe('admin');
    const page = await session.transaction(async (tx) => members.list(tx, { limit: 1 }));
    expect(page.items).toHaveLength(1);
    expect(page.next).not.toBeNull();
    expect(
      await codeOf(
        session.transaction(async (tx) =>
          members.add(tx, { userId: randomUUID(), role: 'superuser' as 'admin' }),
        ),
      ),
    ).toBe('23514');
  });
});
