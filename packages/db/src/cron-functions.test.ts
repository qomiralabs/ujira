// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The cross-tenant cron functions, called as the app login with no tenant
// context, which is how the fan-out calls them.

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let admin: pg.Client;
let app: pg.Client;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

interface Tenant {
  readonly principal_id: string;
  readonly project_id: string;
}

interface Target extends Tenant {
  readonly mandate_instance_id: string;
}

async function newTenant(): Promise<Tenant> {
  const created = await admin.query<Tenant>(
    `select principal_id, project_id
       from ujira.create_principal('Acme', 'Main', $1, 'UTC')`,
    [randomUUID()],
  );
  const tenant = created.rows[0];
  if (tenant === undefined) throw new Error('create_principal returned no row');
  return tenant;
}

async function newInstance(tenant: Tenant): Promise<string> {
  const mandate = await admin.query<{ id: string }>(
    `insert into ujira.mandates (principal_id, project_id, name)
     values ($1, $2, 'Payroll') returning id`,
    [tenant.principal_id, tenant.project_id],
  );
  const instance = await admin.query<{ id: string }>(
    `insert into ujira.mandate_instances
       (principal_id, project_id, mandate_id, chain, contract_address, spec_version, asset, scale)
     values ($1, $2, $3, 'stellar', $4, '1', 'USDC', 7) returning id`,
    [tenant.principal_id, tenant.project_id, mandate.rows[0]?.id, `C${randomUUID()}`],
  );
  const id = instance.rows[0]?.id;
  if (id === undefined) throw new Error('no instance');
  return id;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  app = new pg.Client({ connectionString: roleUrl(roleUrls, 'ujira_app', database.name) });
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await admin.end();
  await database.drop();
});

describe('reconcile_targets', () => {
  it('reconcile_targets keyset pages', async () => {
    const tenants = [await newTenant(), await newTenant()];
    const expected: string[] = [];
    for (const tenant of tenants) {
      for (let count = 0; count < 3; count += 1) expected.push(await newInstance(tenant));
    }
    expected.sort();

    const seen: Target[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const rows: Target[] = (
        await app.query<Target>(`select * from ujira.reconcile_targets($1, 4)`, [after])
      ).rows;
      if (rows.length === 0) break;
      expect(rows.length).toBeLessThanOrEqual(4);
      seen.push(...rows);
      after = rows[rows.length - 1]?.mandate_instance_id ?? null;
    }
    expect(seen.map((row) => row.mandate_instance_id)).toEqual(expected);
    // Every row names its own tenant, and both tenants are in there.
    expect(new Set(seen.map((row) => row.principal_id)).size).toBe(2);
  });

  it('returns only the tenant and the target', async () => {
    const result = await app.query(`select * from ujira.reconcile_targets(null, 1)`);
    expect(result.fields.map((field) => field.name)).toEqual([
      'principal_id',
      'project_id',
      'mandate_instance_id',
    ]);
  });

  it('limit above 500 is refused', async () => {
    expect(await codeOf(app.query(`select * from ujira.reconcile_targets(null, 501)`))).toBe(
      '22023',
    );
    await app.query(`select * from ujira.reconcile_targets(null, 500)`);
  });

  it.each(['0', '-1', 'null'])('a limit of %s is refused', async (limit) => {
    expect(await codeOf(app.query(`select * from ujira.reconcile_targets(null, ${limit})`))).toBe(
      '22023',
    );
  });

  it('the app still cannot scan the table itself', async () => {
    expect(await codeOf(app.query('select id from ujira.mandate_instances'))).toBe('UJ001');
  });
});

describe('funding_hold_targets', () => {
  // Written the normal way, so these rows are real.
  async function hold(tenant: Tenant, network: string): Promise<void> {
    const instance = await newInstance(tenant);
    const recipient = await admin.query<{ id: string }>(
      `insert into ujira.recipients (principal_id, project_id, recipient_ref, country)
       values ($1, $2, $3, 'NG') returning id`,
      [tenant.principal_id, tenant.project_id, randomBytes(32)],
    );
    const mandate = await admin.query<{ mandate_id: string }>(
      'select mandate_id from ujira.mandate_instances where id = $1',
      [instance],
    );
    const payout = await admin.query<{ id: string }>(
      `insert into ujira.payouts
         (principal_id, project_id, idempotency_key, request_hash, recipient_id, mandate_id, method,
          cashout_cost_bearer, requested_amount, requested_asset, requested_chain,
          requested_token_scale, status_reason)
       values ($1, $2, $3, $4, $5, $6, 'stellar_wallet', 'recipient', 100, 'USDC', 'stellar', 7,
               'awaiting_funding')
       returning id`,
      [
        tenant.principal_id,
        tenant.project_id,
        randomUUID(),
        randomBytes(32),
        recipient.rows[0]?.id,
        mandate.rows[0]?.mandate_id,
      ],
    );
    await admin.query(
      `insert into ujira.payout_funding_holds
         (principal_id, project_id, payout_id, network, chain, mandate_instance_id,
          needed_amount, asset, scale)
       values ($1, $2, $3, $4, 'stellar', $5, 100, 'USDC', 7)`,
      [tenant.principal_id, tenant.project_id, payout.rows[0]?.id, network, instance],
    );
  }

  interface HoldTarget extends Tenant {
    readonly network: string;
  }

  it('keyset pages, one row per project and network however many holds', async () => {
    const tenants = [await newTenant(), await newTenant()];
    for (const tenant of tenants) {
      await hold(tenant, 'stellar:testnet');
      await hold(tenant, 'stellar:testnet');
      await hold(tenant, 'stellar:pubnet');
    }
    const seen: HoldTarget[] = [];
    let last: HoldTarget | undefined;
    for (let page = 0; page < 10; page += 1) {
      const rows: readonly HoldTarget[] = (
        await app.query<HoldTarget>(`select * from ujira.funding_hold_targets($1, $2, $3, 3)`, [
          last?.principal_id ?? null,
          last?.project_id ?? null,
          last?.network ?? null,
        ])
      ).rows;
      if (rows.length === 0) break;
      expect(rows.length).toBeLessThanOrEqual(3);
      seen.push(...rows);
      last = rows.at(-1);
    }
    const mine = seen.filter((row) =>
      tenants.some((tenant) => tenant.project_id === row.project_id),
    );
    expect(mine).toHaveLength(4);
    expect(new Set(seen.map((row) => JSON.stringify(row))).size).toBe(seen.length);
  });

  it('returns only the tenant and the network', async () => {
    const result = await app.query(`select * from ujira.funding_hold_targets(null, null, null, 1)`);
    expect(result.fields.map((field) => field.name)).toEqual([
      'principal_id',
      'project_id',
      'network',
    ]);
  });

  it.each(['0', '501', 'null'])('a limit of %s is refused', async (limit) => {
    expect(
      await codeOf(
        app.query(`select * from ujira.funding_hold_targets(null, null, null, ${limit})`),
      ),
    ).toBe('22023');
  });

  it('the app still cannot scan the table itself', async () => {
    expect(await codeOf(app.query('select payout_id from ujira.payout_funding_holds'))).toBe(
      'UJ001',
    );
  });
});

describe('who owns and runs them', () => {
  const FUNCTIONS = [
    'ujira.funding_hold_targets(uuid, uuid, text, integer)',
    'ujira.reconcile_targets(uuid, integer)',
    'ujira.due_attempt_deadlines(timestamp with time zone, integer)',
    'ujira.overdue_fee_refunds(integer)',
  ];

  it.each(FUNCTIONS)('%s is a definer function owned by the scheduler', async (fn) => {
    const result = await admin.query(
      `select pg_get_userbyid(proowner) as owner, prosecdef as definer, proconfig as config
         from pg_proc where oid = $1::regprocedure`,
      [fn],
    );
    expect(result.rows).toEqual([
      { owner: 'ujira_scheduler', definer: true, config: ['search_path=pg_catalog'] },
    ]);
  });

  it.each(FUNCTIONS)('%s can be run by the app alone', async (fn) => {
    const result = await admin.query<{ rolname: string }>(
      `select rolname from pg_roles
        where rolname like 'ujira\\_%'
          and rolname not in ('ujira_scheduler', 'ujira_owner')
          and has_function_privilege(oid, $1, 'EXECUTE')`,
      [fn],
    );
    expect(result.rows).toEqual([{ rolname: 'ujira_app' }]);
  });

  it('the scheduler holds no CREATE on the schema after the handover', async () => {
    const result = await admin.query(
      `select has_schema_privilege('ujira_scheduler', 'ujira', 'CREATE') as allowed`,
    );
    expect(result.rows).toEqual([{ allowed: false }]);
  });
});

// payout_attempts and fee_refunds arrive with their own issues. First, either
// each function runs against the real table with the rights it was given, or the
// table is not there yet. Then each is proved against a small table of the same
// shape, swapped in on this file's own database, so these tests do not depend on
// the order those issues merge in.
describe('the functions whose tables land separately', () => {
  it.each([
    ['ujira.payout_attempts', `select * from ujira.due_attempt_deadlines(now(), 10)`],
    ['ujira.fee_refunds', `select * from ujira.overdue_fee_refunds(10)`],
  ])('%s: runs on the real table once it exists', async (table, statement) => {
    const exists = await admin.query<{ found: boolean }>(
      'select to_regclass($1) is not null as found',
      [table],
    );
    if (exists.rows[0]?.found === true) {
      await app.query(statement);
    } else {
      expect(await codeOf(app.query(statement))).toBe('42P01');
    }
  });

  it('due_attempt_deadlines returns live attempts past the deadline, oldest first', async () => {
    const tenant = await newTenant();
    await admin.query(`
      drop table if exists ujira.payout_attempts cascade;
      set role ujira_owner;
      create table ujira.payout_attempts (
        principal_id uuid not null,
        project_id uuid not null,
        id uuid primary key default gen_random_uuid(),
        deadline timestamptz not null,
        status text not null,
        total_amount bigint not null default 1
      );
      select ujira.apply_tenant_policies('ujira.payout_attempts');
      select ujira.apply_scheduler_read(
        'ujira.payout_attempts',
        array['principal_id', 'project_id', 'id', 'deadline', 'status']
      );
      reset role;
    `);
    const insert = async (deadline: string, status: string): Promise<string> => {
      const row = await admin.query<{ id: string }>(
        `insert into ujira.payout_attempts (principal_id, project_id, deadline, status)
         values ($1, $2, $3, $4) returning id`,
        [tenant.principal_id, tenant.project_id, deadline, status],
      );
      return row.rows[0]?.id ?? '';
    };
    const newer = await insert('2026-01-02T00:00:00Z', 'executing');
    const older = await insert('2026-01-01T00:00:00Z', 'created');
    await insert('2026-01-01T00:00:00Z', 'final');
    await insert('2026-01-01T00:00:00Z', 'dead');
    await insert('2026-01-01T00:00:00Z', 'settled');
    await insert('2027-01-01T00:00:00Z', 'created');

    const result = await app.query(
      `select * from ujira.due_attempt_deadlines('2026-06-01T00:00:00Z', 10)`,
    );
    expect(result.rows).toEqual([
      { ...tenant, attempt_id: older },
      { ...tenant, attempt_id: newer },
    ]);
    const limited = await app.query(
      `select * from ujira.due_attempt_deadlines('2026-06-01T00:00:00Z', 1)`,
    );
    expect(limited.rows).toEqual([{ ...tenant, attempt_id: older }]);

    expect(await codeOf(app.query(`select * from ujira.due_attempt_deadlines(null, 10)`))).toBe(
      '22004',
    );
    expect(await codeOf(app.query(`select * from ujira.due_attempt_deadlines(now(), 501)`))).toBe(
      '22023',
    );
  });

  it('overdue_fee_refunds returns unfinished refunds past due', async () => {
    const tenant = await newTenant();
    await admin.query(`
      drop table if exists ujira.fee_refunds cascade;
      set role ujira_owner;
      create table ujira.fee_refunds (
        principal_id uuid not null,
        project_id uuid not null,
        id uuid primary key default gen_random_uuid(),
        due_at timestamptz not null,
        status text not null
      );
      select ujira.apply_tenant_policies('ujira.fee_refunds');
      select ujira.apply_scheduler_read(
        'ujira.fee_refunds',
        array['principal_id', 'project_id', 'id', 'due_at', 'status']
      );
      reset role;
    `);
    const insert = async (dueAt: string, status: string): Promise<string> => {
      const row = await admin.query<{ id: string }>(
        `insert into ujira.fee_refunds (principal_id, project_id, due_at, status)
         values ($1, $2, $3, $4) returning id`,
        [tenant.principal_id, tenant.project_id, dueAt, status],
      );
      return row.rows[0]?.id ?? '';
    };
    const owed = await insert('2020-01-01T00:00:00Z', 'owed');
    const stuck = await insert('2020-01-02T00:00:00Z', 'awaiting_signatures');
    await insert('2020-01-01T00:00:00Z', 'settled');
    await insert('2020-01-01T00:00:00Z', 'not_owed');
    await insert('2999-01-01T00:00:00Z', 'owed');

    const result = await app.query(`select * from ujira.overdue_fee_refunds(10)`);
    expect(result.rows).toEqual([
      { ...tenant, fee_refund_id: owed },
      { ...tenant, fee_refund_id: stuck },
    ]);
    expect(await codeOf(app.query(`select * from ujira.overdue_fee_refunds(501)`))).toBe('22023');
  });
});
