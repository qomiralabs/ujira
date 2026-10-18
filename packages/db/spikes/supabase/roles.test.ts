// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Spike: do custom NOBYPASSRLS login roles, role targeted policies and
// security definer functions behave on Supabase as on plain Postgres, and
// do the four worker checks hold? Runs only when the pooler URLs are in the
// environment (never in CI). Every object is created under a fresh prefix
// and dropped afterwards.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TENANT_A,
  TENANT_B,
  bootstrap,
  cleanup,
  close,
  connectAs,
  definerDdl,
  jobsDdl,
  runPrefix,
  spikeEnv,
  sqlState,
  tenantDdl,
  tenantTx,
} from './harness.js';
import type { Spike } from './harness.js';

const env = spikeEnv();

describe.skipIf(env === null)('Supabase roles and policies', { timeout: 60_000 }, () => {
  let spike: Spike;
  let migrator: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;
  let reader: pg.Client;
  let retention: pg.Client;
  let rowB = '';
  let s = '';

  beforeAll(async () => {
    if (env === null) return;
    spike = await bootstrap(env, runPrefix('r'));
    s = spike.names.tenantSchema;
    migrator = await connectAs(env, 'session', spike.logins.migrator);
    await migrator.query(tenantDdl(spike.names));
    await spike.admin.query(definerDdl(spike.names));
    worker = await connectAs(env, 'session', spike.logins.worker);
    await worker.query(jobsDdl(spike.names));
    app = await connectAs(env, 'transaction', spike.logins.app);
    reader = await connectAs(env, 'session', spike.logins.reader);
    retention = await connectAs(env, 'session', spike.logins.retention);
    await tenantTx(app, TENANT_A, async () => {
      await app.query(
        `insert into ${s}.items (principal_id, project_id, note) values ($1, $2, 'a live')`,
        [TENANT_A.principalId, TENANT_A.projectId],
      );
      await app.query(
        `insert into ${s}.items (principal_id, project_id, note, expires_at) values ($1, $2, 'a expired', now() - interval '1 day')`,
        [TENANT_A.principalId, TENANT_A.projectId],
      );
    });
    rowB = await tenantTx(app, TENANT_B, async () => {
      const r = await app.query<{ id: string }>(
        `insert into ${s}.items (principal_id, project_id, note) values ($1, $2, 'b live') returning id`,
        [TENANT_B.principalId, TENANT_B.projectId],
      );
      return r.rows[0]?.id ?? '';
    });
  }, 180_000);

  afterAll(async () => {
    if (env === null) return;
    await close(migrator, app, worker, reader, retention);
    // A failed setup leaves nothing to tear down.
    if ((spike as Spike | undefined) === undefined) return;
    await cleanup(spike.admin, spike.names);
    await spike.admin.end();
  }, 120_000);

  const count = async (client: pg.Client): Promise<number> => {
    const r = await client.query<{ n: number }>(`select count(*)::int as n from ${s}.items`);
    return r.rows[0]?.n ?? -1;
  };

  it('the postgres role creates NOBYPASSRLS login roles and a NOLOGIN owner', async () => {
    const r = await spike.admin.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      'select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = any($1) order by rolname',
      [
        [
          spike.names.owner,
          spike.names.migrator,
          spike.names.app,
          spike.names.worker,
          spike.names.reader,
          spike.names.retention,
          spike.names.auth,
        ],
      ],
    );
    expect(r.rows).toHaveLength(7);
    for (const row of r.rows) {
      expect(row.rolbypassrls).toBe(false);
      expect(row.rolsuper).toBe(false);
      const login = !row.rolname.endsWith('_owner') && !row.rolname.endsWith('_auth');
      expect(row.rolcanlogin).toBe(login);
    }
    const me = await spike.admin.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
      'select rolsuper, rolcreaterole from pg_roles where rolname = current_user',
    );
    // Supabase's postgres role is not a superuser, but it can create roles.
    expect(me.rows[0]).toEqual({ rolsuper: false, rolcreaterole: true });
  });

  it('custom login roles connect through both poolers', async () => {
    for (const client of [app, migrator, worker, reader, retention]) {
      const r = await client.query<{ u: string }>('select current_user as u');
      expect(r.rows[0]?.u.startsWith('s49r')).toBe(true);
    }
  });

  it('the app sees only its own tenant', async () => {
    expect(await tenantTx(app, TENANT_A, () => count(app))).toBe(2);
    expect(await tenantTx(app, TENANT_B, () => count(app))).toBe(1);
  });

  it("the app cannot write another tenant's row", async () => {
    const state = await sqlState(() =>
      tenantTx(app, TENANT_A, () =>
        app.query(`insert into ${s}.items (principal_id, project_id, note) values ($1, $2, 'x')`, [
          TENANT_B.principalId,
          TENANT_B.projectId,
        ]),
      ),
    );
    expect(state).toBe('42501');
  });

  it('without tenant context every read fails with UJ001', async () => {
    expect(await sqlState(() => count(app))).toBe('UJ001');
  });

  it('scope all reads every project of the principal and refuses writes', async () => {
    const all = { principalId: TENANT_A.principalId, projectId: 'all' } as const;
    expect(await tenantTx(app, all, () => count(app))).toBe(2);
    const state = await sqlState(() =>
      tenantTx(app, all, () =>
        app.query(`insert into ${s}.items (principal_id, project_id, note) values ($1, $2, 'x')`, [
          TENANT_A.principalId,
          TENANT_A.projectId,
        ]),
      ),
    );
    expect(state).toBe('42501');
  });

  it('the app updates only granted columns and never deletes', async () => {
    await tenantTx(app, TENANT_A, () => app.query(`update ${s}.items set note = note || '!'`));
    expect(
      await sqlState(() =>
        tenantTx(app, TENANT_A, () => app.query(`update ${s}.items set expires_at = now()`)),
      ),
    ).toBe('42501');
    expect(
      await sqlState(() => tenantTx(app, TENANT_A, () => app.query(`delete from ${s}.items`))),
    ).toBe('42501');
  });

  it('the reader reads through the same policies and cannot write', async () => {
    expect(await tenantTx(reader, TENANT_A, () => count(reader))).toBe(2);
    expect(
      await sqlState(() =>
        tenantTx(reader, TENANT_A, () =>
          reader.query(
            `insert into ${s}.items (principal_id, project_id, note) values ($1, $2, 'x')`,
            [TENANT_A.principalId, TENANT_A.projectId],
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('a security definer function owned by a narrow role is the only cross-tenant path', async () => {
    const direct = await tenantTx(app, TENANT_A, () =>
      app.query(`select id from ${s}.items where id = $1`, [rowB]),
    );
    expect(direct.rows).toHaveLength(0);
    const looked = await tenantTx(app, TENANT_A, () =>
      app.query<{ principal_id: string }>(`select principal_id from ${s}.lookup_item($1)`, [rowB]),
    );
    expect(looked.rows).toEqual([{ principal_id: TENANT_B.principalId }]);
    const owner = await spike.admin.query<{ owner: string; definer: boolean }>(
      `select pg_get_userbyid(proowner) as owner, prosecdef as definer from pg_proc where oid = '${s}.lookup_item(uuid)'::regprocedure`,
    );
    expect(owner.rows[0]).toEqual({ owner: spike.names.auth, definer: true });
    // The reader was never granted it.
    expect(
      await sqlState(() =>
        tenantTx(reader, TENANT_A, () =>
          reader.query(`select * from ${s}.lookup_item($1)`, [rowB]),
        ),
      ),
    ).toBe('42501');
  });

  it('the retention role deletes only expired rows, without tenant context', async () => {
    const r = await retention.query(`delete from ${s}.items`);
    expect(r.rowCount).toBe(1);
    expect(await tenantTx(app, TENANT_A, () => count(app))).toBe(1);
  });

  it('the Supabase API roles have no access to the tenant schema', async () => {
    const r = await spike.admin.query<{ role: string; usage: boolean }>(
      `select r as role, has_schema_privilege(r, $1, 'USAGE') as usage
         from unnest(array['anon', 'authenticated', 'service_role']) as r`,
      [s],
    );
    expect(r.rows.every((row) => !row.usage)).toBe(true);
  });

  it('the Supabase API roles hold no table, column or function privilege and no default ACL there', async () => {
    const api = ['anon', 'authenticated', 'service_role'];
    const tables = await spike.admin.query<{ role: string; table: string; privilege: string }>(
      `select r as role, c.relname as table, p as privilege
         from unnest($1::text[]) as r,
              pg_class c join pg_namespace n on n.oid = c.relnamespace,
              unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p
        where n.nspname = $2 and c.relkind in ('r', 'p', 'v', 'm', 'S')
          and has_table_privilege(r, c.oid, p)`,
      [api, s],
    );
    expect(tables.rows).toEqual([]);
    const columns = await spike.admin.query<{ n: number }>(
      `select count(*)::int as n
         from unnest($1::text[]) as r, information_schema.column_privileges cp
        where cp.table_schema = $2 and cp.grantee = r`,
      [api, s],
    );
    expect(columns.rows[0]?.n).toBe(0);
    const functions = await spike.admin.query<{ role: string; fn: string }>(
      `select r as role, p.oid::regprocedure::text as fn
         from unnest($1::text[]) as r, pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $2 and has_function_privilege(r, p.oid, 'EXECUTE')`,
      [api, s],
    );
    expect(functions.rows).toEqual([]);
    // Default ACLs that would grant future objects in this schema, or in
    // every schema, to an API role.
    const defaults = await spike.admin.query<{ owner: string; schema: string | null; acl: string }>(
      `select pg_get_userbyid(d.defaclrole) as owner, n.nspname as schema, a::text as acl
         from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace,
              unnest(d.defaclacl) as a
        where (d.defaclnamespace = 0 or n.nspname = $1::text)
          and pg_get_userbyid(d.defaclrole) in ($2::text, $3::text)
          and (a::text like 'anon=%' or a::text like 'authenticated=%' or a::text like 'service_role=%')`,
      [s, spike.names.owner, spike.names.worker],
    );
    expect(defaults.rows).toEqual([]);
  });

  describe('worker checks', () => {
    it('LISTEN and NOTIFY work through the session pooler', async () => {
      let delivered = '';
      worker.on('notification', (msg) => {
        delivered = msg.payload ?? '';
      });
      await worker.query(`listen ${spike.names.jobsSchema}_wake`);
      await app.query(`select pg_notify($1, 'job')`, [`${spike.names.jobsSchema}_wake`]);
      const started = Date.now();
      while (delivered === '' && Date.now() - started < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(delivered).toBe('job');
    });

    it('the worker role can hold CREATE on the database and installs its own schema', async () => {
      const r = await spike.admin.query<{ create: boolean; owner: string; tenant: boolean }>(
        `select has_database_privilege($1, current_database(), 'CREATE') as create,
                (select pg_get_userbyid(nspowner) from pg_namespace where nspname = $2) as owner,
                has_schema_privilege($1, $3, 'USAGE') as tenant`,
        [spike.names.worker, spike.names.jobsSchema, s],
      );
      expect(r.rows[0]).toEqual({ create: true, owner: spike.names.worker, tenant: false });
    });

    it('a security definer function in a non-public schema enqueues with the tenant from context', async () => {
      const j = spike.names.jobsSchema;
      const id = await tenantTx(app, TENANT_A, async () => {
        const r = await app.query<{ id: string }>(
          `select ${j}.enqueue('payout:advance')::text as id`,
        );
        return r.rows[0]?.id ?? '';
      });
      const job = await worker.query<{ payload: Record<string, string> }>(
        `select payload from ${j}.jobs where id = $1`,
        [id],
      );
      expect(job.rows[0]?.payload).toEqual({
        task: 'payout:advance',
        principalId: TENANT_A.principalId,
        projectId: TENANT_A.projectId,
      });
      expect(await sqlState(() => app.query(`select ${j}.enqueue('x')`))).toBe('UJ001');
      expect(await sqlState(() => app.query(`select * from ${j}.jobs`))).toBe('42501');
      // Functions the worker creates are not executable by PUBLIC.
      const pub = await spike.admin.query<{ reader: boolean }>(
        `select has_function_privilege($1, '${j}.enqueue(text)', 'EXECUTE') as reader`,
        [spike.names.reader],
      );
      expect(pub.rows[0]?.reader).toBe(false);
    });

    it('the postgres role ran the whole roles bootstrap', async () => {
      const r = await spike.admin.query<{ n: number }>(
        `select count(*)::int as n from pg_roles where rolname like $1`,
        [`${spike.names.owner.slice(0, -'_owner'.length)}\\_%`],
      );
      expect(r.rows[0]?.n).toBe(7);
    });
  });
});
