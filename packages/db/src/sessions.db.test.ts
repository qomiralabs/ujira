// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A session resolves only while it is unexpired, unrevoked and backed by an active
// membership, and only through the functions: nobody can read the table.

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { entryPoints } from './repositories/entry-points.js';
import { memberSessions } from './repositories/sessions.js';
import type { NewMemberSession } from './repositories/sessions.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import {
  createTestDatabase,
  roleUrl,
  type LoginRole,
  type TestDatabase,
} from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;

interface Tenant {
  readonly principalId: string;
  readonly projectId: string;
  readonly owner: string;
}

let first: Tenant;
let second: Tenant;

async function newTenant(): Promise<Tenant> {
  const owner = randomUUID();
  const created = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: `principal-${randomUUID()}`,
      projectName: 'project',
      ownerUserId: owner,
    }),
  );
  return { ...created, owner };
}

async function signIn(subject: string, change: Partial<NewMemberSession> = {}): Promise<Buffer> {
  const secretHash = randomBytes(32);
  await db.unscoped(async (tx) =>
    memberSessions.create(tx, {
      secretHash,
      authSubject: subject,
      supabaseSessionId: `supabase-${randomUUID()}`,
      aal: 'aal1',
      idleSeconds: 1800,
      absoluteSeconds: 43_200,
      ipHmac: randomBytes(32),
      userAgentFamily: 'Firefox',
      ...change,
    }),
  );
  return secretHash;
}

const resolve = (hash: Buffer) => db.unscoped(async (tx) => memberSessions.resolve(tx, hash));
const select = (hash: Buffer, principalId: string, projectId: string | null) =>
  db.unscoped(async (tx) => memberSessions.select(tx, hash, principalId, projectId));

async function as<T>(role: LoginRole, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(roleUrls, role, database.name) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const codeOf = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => 'resolved',
    (error: unknown) => (error as { code?: unknown }).code,
  );

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  first = await newTenant();
  second = await newTenant();
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('resolving a session', () => {
  it('finds a live session, with no tenant until one is chosen', async () => {
    const hash = await signIn(first.owner);
    const session = await resolve(hash);
    expect(session).toMatchObject({
      authSubject: first.owner,
      aal: 'aal1',
      principalId: null,
      projectId: null,
      memberRole: null,
      steppedUpAt: null,
    });
  });

  it('finds nothing for a secret it does not know', async () => {
    expect(await resolve(randomBytes(32))).toBeUndefined();
  });

  it('idle expired', async () => {
    const hash = await signIn(first.owner);
    await admin.query(
      `update ujira.member_sessions set idle_expires_at = now() - interval '1 second'
        where secret_hash = $1`,
      [hash],
    );
    expect(await resolve(hash)).toBeUndefined();
  });

  it('absolute expired', async () => {
    const hash = await signIn(first.owner);
    await admin.query(
      `update ujira.member_sessions
          set idle_expires_at = now() - interval '1 second',
              absolute_expires_at = now() - interval '1 second'
        where secret_hash = $1`,
      [hash],
    );
    expect(await resolve(hash)).toBeUndefined();
  });

  it('revoked', async () => {
    const hash = await signIn(first.owner);
    expect(await db.unscoped(async (tx) => memberSessions.revoke(tx, hash, 'signed_out'))).toBe(
      true,
    );
    expect(await resolve(hash)).toBeUndefined();
    expect(await db.unscoped(async (tx) => memberSessions.revoke(tx, hash, 'signed_out'))).toBe(
      false,
    );
  });

  it.each(['suspended', 'removed', 'invited'])(
    'stops resolving once the membership behind it is %s',
    async (status) => {
      const member = randomUUID();
      await admin.query(
        `insert into ujira.principal_members (principal_id, user_id, role) values ($1, $2, 'admin')`,
        [first.principalId, member],
      );
      const hash = await signIn(member);
      expect(await select(hash, first.principalId, first.projectId)).toBe(true);
      expect((await resolve(hash))?.memberRole).toBe('admin');
      await admin.query(
        `update ujira.principal_members
            set status = $1,
                invite_secret_hash = case when $1 = 'invited' then $4::bytea end,
                invite_expires_at = case when $1 = 'invited' then now() + interval '1 day' end,
                invited_by = case when $1 = 'invited' then $5::uuid end
          where principal_id = $2 and user_id = $3`,
        [status, first.principalId, member, randomBytes(32), first.owner],
      );
      expect(await resolve(hash)).toBeUndefined();
    },
  );

  it('stops resolving once the member row is gone', async () => {
    const member = randomUUID();
    await admin.query(
      `insert into ujira.principal_members (principal_id, user_id, role) values ($1, $2, 'viewer')`,
      [first.principalId, member],
    );
    const hash = await signIn(member);
    expect(await select(hash, first.principalId, null)).toBe(true);
    await admin.query(
      `delete from ujira.principal_members where principal_id = $1 and user_id = $2`,
      [first.principalId, member],
    );
    expect(await resolve(hash)).toBeUndefined();
  });
});

describe('choosing a tenant', () => {
  it('session_select of a principal the subject is a member of takes effect', async () => {
    const hash = await signIn(first.owner);
    expect(await select(hash, first.principalId, first.projectId)).toBe(true);
    expect(await resolve(hash)).toMatchObject({
      principalId: first.principalId,
      projectId: first.projectId,
      memberRole: 'owner',
    });
  });

  it('session_select of a principal the subject is not a member of is refused', async () => {
    const hash = await signIn(first.owner);
    expect(await select(hash, second.principalId, second.projectId)).toBe(false);
    expect(await resolve(hash)).toMatchObject({ principalId: null, projectId: null });
  });

  it("refuses another principal's project under one's own principal", async () => {
    const hash = await signIn(first.owner);
    expect(await select(hash, first.principalId, second.projectId)).toBe(false);
    expect(await resolve(hash)).toMatchObject({ principalId: null, projectId: null });
  });

  it('refuses a person whose membership is not active', async () => {
    const member = randomUUID();
    await admin.query(
      `insert into ujira.principal_members
         (principal_id, user_id, role, status, invite_secret_hash, invite_expires_at, invited_by)
       values ($1, $2, 'viewer', 'invited', $3, now() + interval '1 day', $4)`,
      [first.principalId, member, randomBytes(32), first.owner],
    );
    expect(await select(await signIn(member), first.principalId, null)).toBe(false);
  });

  it('refuses a session that is not live', async () => {
    const hash = await signIn(first.owner);
    await db.unscoped(async (tx) => memberSessions.revoke(tx, hash, 'signed_out'));
    expect(await select(hash, first.principalId, first.projectId)).toBe(false);
  });

  it('keeps a project from being set with no principal', async () => {
    const hash = await signIn(first.owner);
    expect(
      await codeOf(
        admin.query(`update ujira.member_sessions set project_id = $1 where secret_hash = $2`, [
          first.projectId,
          hash,
        ]),
      ),
    ).toBe('23514');
  });
});

describe('the memberships of a person', () => {
  it('lists only their own active memberships', async () => {
    const member = randomUUID();
    await admin.query(
      `insert into ujira.principal_members (principal_id, user_id, role, status) values
         ($1, $3, 'admin', 'active'), ($2, $3, 'viewer', 'suspended')`,
      [first.principalId, second.principalId, member],
    );
    expect(await db.unscoped(async (tx) => memberSessions.memberships(tx, member))).toEqual([
      { principalId: first.principalId, role: 'admin' },
    ]);
  });
});

describe('keeping a session alive', () => {
  it('extends the idle window, never past the absolute expiry', async () => {
    const hash = await signIn(first.owner, { idleSeconds: 60, absoluteSeconds: 120 });
    const before = await resolve(hash);
    const extended = await db.unscoped(async (tx) => memberSessions.touch(tx, hash, 86_400));
    expect(extended).toEqual(before?.absoluteExpiresAt);
  });

  it('never starts longer than its absolute expiry', async () => {
    const hash = await signIn(first.owner, { idleSeconds: 9_999, absoluteSeconds: 60 });
    const session = await resolve(hash);
    expect(session?.idleExpiresAt).toEqual(session?.absoluteExpiresAt);
  });

  it('does not bring a lapsed session back', async () => {
    const hash = await signIn(first.owner);
    await admin.query(
      `update ujira.member_sessions set idle_expires_at = now() - interval '1 second'
        where secret_hash = $1`,
      [hash],
    );
    expect(await db.unscoped(async (tx) => memberSessions.touch(tx, hash, 60))).toBeUndefined();
    expect(await resolve(hash)).toBeUndefined();
  });

  it('refuses a window of no length', async () => {
    const hash = await signIn(first.owner);
    expect(await codeOf(db.unscoped(async (tx) => memberSessions.touch(tx, hash, 0)))).toBe(
      '22023',
    );
    expect(await codeOf(signIn(first.owner, { idleSeconds: 0 }))).toBe('22023');
    expect(await codeOf(signIn(first.owner, { absoluteSeconds: 0 }))).toBe('22023');
  });

  it('records a step up, with the time from the server', async () => {
    const hash = await signIn(first.owner);
    expect(await db.unscoped(async (tx) => memberSessions.stepUp(tx, hash, 'aal2'))).toBe(true);
    const session = await resolve(hash);
    expect(session?.aal).toBe('aal2');
    expect(session?.steppedUpAt).toBeInstanceOf(Date);
    await db.unscoped(async (tx) => memberSessions.revoke(tx, hash, 'signed_out'));
    expect(await db.unscoped(async (tx) => memberSessions.stepUp(tx, hash, 'aal2'))).toBe(false);
  });
});

describe('revoking every session of a person', () => {
  it("ends all of theirs and nobody else's", async () => {
    const person = randomUUID();
    const hashes = [await signIn(person), await signIn(person)];
    const other = await signIn(second.owner);
    expect(
      await db.unscoped(async (tx) => memberSessions.revokeSubject(tx, person, 'password_changed')),
    ).toBe(2);
    for (const hash of hashes) expect(await resolve(hash)).toBeUndefined();
    expect(await resolve(other)).toBeDefined();
    const { rows } = await admin.query<{ revoked_reason: string }>(
      `select revoked_reason from ujira.member_sessions where auth_subject = $1`,
      [person],
    );
    expect(rows.map((row) => row.revoked_reason)).toEqual(['password_changed', 'password_changed']);
  });
});

describe('the shape of a session', () => {
  it('refuses an assurance level it does not know', async () => {
    expect(await codeOf(signIn(first.owner, { aal: 'aal3' as 'aal1' }))).toBe('23514');
  });

  it('refuses a reason that is free text', async () => {
    const hash = await signIn(first.owner);
    expect(
      await codeOf(db.unscoped(async (tx) => memberSessions.revoke(tx, hash, 'Signed out by Ada'))),
    ).toBe('23514');
  });

  it('refuses a user agent that is more than a family', async () => {
    const userAgentFamily =
      'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
    expect(await codeOf(signIn(first.owner, { userAgentFamily }))).toBe('23514');
  });

  it('refuses a secret hash used twice, and a hash of the wrong length', async () => {
    const secretHash = await signIn(first.owner);
    expect(await codeOf(signIn(first.owner, { secretHash }))).toBe('23505');
    expect(await codeOf(signIn(first.owner, { secretHash: randomBytes(16) }))).toBe('23514');
  });
});

describe('who can reach the table', () => {
  const SERVICE_ROLES: readonly LoginRole[] = [
    'ujira_app',
    'ujira_reader',
    'ujira_retention',
    'ujira_auth',
    'ujira_indexer',
    'ujira_ops',
  ];

  it('select on member_sessions as app is denied', async () => {
    await signIn(first.owner);
    const code = await as('ujira_app', (client) =>
      codeOf(client.query('select * from ujira.member_sessions')),
    );
    expect(code).toBe('42501');
  });

  it.each(SERVICE_ROLES)('%s can neither read nor change the table', async (role) => {
    const codes = await as(role, async (client) => [
      await codeOf(client.query('select * from ujira.member_sessions')),
      await codeOf(client.query(`update ujira.member_sessions set aal = 'aal2'`)),
      await codeOf(client.query('delete from ujira.member_sessions')),
    ]);
    expect(codes).toEqual(['42501', '42501', '42501']);
  });

  it.each(['ujira_reader', 'ujira_indexer', 'ujira_retention', 'ujira_ops'] as const)(
    '%s cannot call the session functions',
    async (role) => {
      const code = await as(role, (client) =>
        codeOf(client.query('select * from ujira.session_resolve($1)', [randomBytes(32)])),
      );
      expect(code).toBe('42501');
    },
  );

  it('ujira_auth can resolve a session through the function', async () => {
    const hash = await signIn(first.owner);
    const rows = await as('ujira_auth', async (client) => {
      const result = await client.query<{ auth_subject: string }>(
        'select auth_subject from ujira.session_resolve($1)',
        [hash],
      );
      return result.rows;
    });
    expect(rows).toEqual([{ auth_subject: first.owner }]);
  });

  it('every function runs with a fixed search path and as its narrow role', async () => {
    const { rows } = await admin.query<{ name: string; owner: string; config: string[] | null }>(
      `select p.proname as name, pg_get_userbyid(p.proowner) as owner, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'ujira' and (p.proname like 'session\\_%' or p.proname = 'member_memberships')`,
    );
    expect(rows.map((row) => row.name).sort()).toEqual([
      'member_memberships',
      'session_create',
      'session_delete_expired',
      'session_resolve',
      'session_revoke',
      'session_revoke_subject',
      'session_select',
      'session_step_up',
      'session_touch',
    ]);
    for (const row of rows) {
      expect(row.owner, row.name).toBe('ujira_fn_sessions');
      expect(row.config, row.name).toEqual(['search_path=pg_catalog']);
    }
  });
});

describe('retention', () => {
  const removeExpired = (batch: number) =>
    as('ujira_retention', async (client) => {
      const { rows } = await client.query<{ removed: string }>(
        'select ujira.session_delete_expired($1) as removed',
        [batch],
      );
      return Number(rows[0]?.removed);
    });

  const exists = async (hash: Buffer) =>
    (await admin.query('select 1 from ujira.member_sessions where secret_hash = $1', [hash]))
      .rowCount === 1;

  it('deletes sessions 30 days after expiry or revocation, and no sooner', async () => {
    const expired = await signIn(first.owner);
    const revoked = await signIn(first.owner);
    const recentlyExpired = await signIn(first.owner);
    const live = await signIn(first.owner);
    await admin.query(
      `update ujira.member_sessions
          set idle_expires_at = now() - interval '31 days', absolute_expires_at = now() - interval '31 days'
        where secret_hash = $1`,
      [expired],
    );
    await admin.query(
      `update ujira.member_sessions set revoked_at = now() - interval '31 days', revoked_reason = 'signed_out'
        where secret_hash = $1`,
      [revoked],
    );
    await admin.query(
      `update ujira.member_sessions
          set idle_expires_at = now() - interval '29 days', absolute_expires_at = now() - interval '29 days'
        where secret_hash = $1`,
      [recentlyExpired],
    );
    expect(await removeExpired(100)).toBe(2);
    expect(await exists(expired)).toBe(false);
    expect(await exists(revoked)).toBe(false);
    expect(await exists(recentlyExpired)).toBe(true);
    expect(await exists(live)).toBe(true);
    expect(await removeExpired(100)).toBe(0);
  });

  it('removes one batch at a time and refuses a batch out of range', async () => {
    const hashes = [await signIn(first.owner), await signIn(first.owner)];
    await admin.query(
      `update ujira.member_sessions
          set idle_expires_at = now() - interval '31 days', absolute_expires_at = now() - interval '31 days'
        where secret_hash = any($1::bytea[])`,
      [hashes],
    );
    expect(await removeExpired(1)).toBe(1);
    expect(await removeExpired(1)).toBe(1);
    expect(await codeOf(removeExpired(0))).toBe('22023');
    expect(await codeOf(removeExpired(10_001))).toBe('22023');
  });

  it('is not the app role to call', async () => {
    const code = await as('ujira_app', (client) =>
      codeOf(client.query('select ujira.session_delete_expired(1)')),
    );
    expect(code).toBe('42501');
  });
});
