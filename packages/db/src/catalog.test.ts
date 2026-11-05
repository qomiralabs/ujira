// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { jobPayloadProblems } from './repositories/jobs.js';
import {
  catalogProblems,
  definerProblems,
  DEFINER_ALLOWLIST,
  infrastructureProblems,
  INFRASTRUCTURE_SCHEMAS,
} from './testing/catalog.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let migrated: TestDatabase;
let fixtures: TestDatabase;
let fixtureClient: pg.Client;
let fixtureProblems: string[];

// A tenant table built the way every migration builds one: as the owner,
// with the policy template applied and the app granted what it needs.
const COMPLIANT = `
  set role ujira_owner;
  create table ujira.fixture_parent (
    principal_id uuid not null,
    project_id uuid not null,
    id bigint generated always as identity,
    primary key (principal_id, project_id, id)
  );
  select ujira.apply_tenant_policies('ujira.fixture_parent');
  grant select, insert, update on ujira.fixture_parent to ujira_app;
  grant select on ujira.fixture_parent to ujira_reader;
  create table ujira.fixture_child (
    principal_id uuid not null,
    project_id uuid not null,
    parent_id bigint not null,
    foreign key (principal_id, project_id, parent_id)
      references ujira.fixture_parent (principal_id, project_id, id)
  );
  select ujira.apply_tenant_policies('ujira.fixture_child');
  reset role;
`;

// One table per rule, each breaking only that rule.
const BROKEN = `
  set role ujira_owner;
  create table ujira.fixture_no_rls (principal_id uuid not null, project_id uuid not null);
  create table ujira.fixture_not_forced (principal_id uuid not null, project_id uuid not null);
  alter table ujira.fixture_not_forced enable row level security;
  create table ujira.fixture_nullable (principal_id uuid, project_id uuid not null);
  select ujira.apply_tenant_policies('ujira.fixture_nullable');
  create table ujira.fixture_untenanted (id bigint);
  alter table ujira.fixture_untenanted enable row level security;
  alter table ujira.fixture_untenanted force row level security;
  create table ujira.fixture_delete (principal_id uuid not null, project_id uuid not null);
  select ujira.apply_tenant_policies('ujira.fixture_delete');
  grant delete on ujira.fixture_delete to ujira_app;
  create table ujira.fixture_loose_child (
    principal_id uuid not null,
    project_id uuid not null,
    parent_principal uuid not null,
    parent_project uuid not null,
    parent_id bigint not null,
    foreign key (parent_principal, parent_project, parent_id)
      references ujira.fixture_parent (principal_id, project_id, id)
  );
  select ujira.apply_tenant_policies('ujira.fixture_loose_child');
  reset role;
  create table ujira.fixture_wrong_owner (principal_id uuid not null, project_id uuid not null);
  select ujira.apply_tenant_policies('ujira.fixture_wrong_owner');
`;

beforeAll(async () => {
  migrated = await createTestDatabase(adminUrl, import.meta.url);
  fixtures = await createTestDatabase(adminUrl, `${import.meta.url}#fixtures`);
  fixtureClient = new pg.Client({ connectionString: fixtures.url });
  await fixtureClient.connect();
  await fixtureClient.query(COMPLIANT);
  await fixtureClient.query(BROKEN);
  fixtureProblems = await catalogProblems(fixtureClient);
});

afterAll(async () => {
  await fixtureClient.end();
  await fixtures.drop();
  await migrated.drop();
});

async function asMigrated<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: migrated.url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function problemsOf(table: string): string[] {
  return fixtureProblems.filter((problem) => problem.startsWith(`ujira.${table}:`));
}

describe('catalog', () => {
  it('passes the migrated schema', async () => {
    const client = new pg.Client({ connectionString: migrated.url });
    await client.connect();
    try {
      expect(await catalogProblems(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  // The tenant rules above do not reach schema ops, which holds no tenant data,
  // so its tables are listed here one by one as they arrive.
  it('lists ops.fee_estimates, with no tenant columns', async () => {
    const client = new pg.Client({ connectionString: migrated.url });
    await client.connect();
    try {
      const columns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'ops' and table_name = 'fee_estimates'
          order by ordinal_position`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'network',
        'op',
        'leg_count',
        'p95_resource_fee_stroops',
        'p95_rent_stroops',
        'p95_inclusion_fee_stroops',
        'sample_count',
        'window_start',
        'window_end',
        'computed_at',
      ]);
    } finally {
      await client.end();
    }
  });

  it('lists ops.rate_limit_buckets, with no tenant columns', async () => {
    const client = new pg.Client({ connectionString: migrated.url });
    await client.connect();
    try {
      const columns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'ops' and table_name = 'rate_limit_buckets'
          order by ordinal_position`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'bucket_key',
        'tokens',
        'refilled_at',
      ]);
    } finally {
      await client.end();
    }
  });

  it('passes a tenant table built with the template, and a composite foreign key', () => {
    expect(problemsOf('fixture_parent')).toEqual([]);
    expect(problemsOf('fixture_child')).toEqual([]);
  });

  it('fails a table without row level security', () => {
    expect(problemsOf('fixture_no_rls')).toEqual([
      'ujira.fixture_no_rls: row level security is not enabled',
      'ujira.fixture_no_rls: row level security is not forced',
    ]);
  });

  it('fails a table that enables row level security without forcing it', () => {
    expect(problemsOf('fixture_not_forced')).toEqual([
      'ujira.fixture_not_forced: row level security is not forced',
    ]);
  });

  it('fails a nullable tenant column, and a table without tenant columns', () => {
    expect(problemsOf('fixture_nullable')).toEqual([
      'ujira.fixture_nullable: principal_id is nullable',
    ]);
    expect(problemsOf('fixture_untenanted')).toEqual([
      'ujira.fixture_untenanted: has no principal_id',
      'ujira.fixture_untenanted: has no project_id',
    ]);
  });

  it('fails a granted command that has no policy', () => {
    expect(problemsOf('fixture_delete')).toEqual([
      'ujira.fixture_delete: ujira_app is granted DELETE with no policy for it',
    ]);
  });

  it('fails a foreign key to a tenant table that does not carry both tenant columns', () => {
    expect(problemsOf('fixture_loose_child')).toEqual([
      expect.stringMatching(
        /^ujira\.fixture_loose_child: foreign key \S+ to ujira\.fixture_parent does not carry its tenant columns$/,
      ),
    ]);
  });

  it('fails a table not owned by the owner role', () => {
    expect(problemsOf('fixture_wrong_owner')).toEqual([
      expect.stringMatching(/^ujira\.fixture_wrong_owner: owned by \S+, not ujira_owner$/),
    ]);
  });

  it('reports nothing beyond the broken fixtures', () => {
    const named = [
      'fixture_no_rls',
      'fixture_not_forced',
      'fixture_nullable',
      'fixture_untenanted',
      'fixture_delete',
      'fixture_loose_child',
      'fixture_wrong_owner',
    ];
    expect(
      fixtureProblems.filter(
        (problem) => !named.some((table) => problem.startsWith(`ujira.${table}:`)),
      ),
    ).toEqual([]);
  });
});

// The queue schemas are a declared exception to the tenant rules above, so these
// hold the exception to its word, and any way past row level security to a list.
describe('the queue schemas', () => {
  it('graphile_worker and ujira_jobs are infrastructure with no tenant or personal data columns', async () => {
    await asMigrated(async (client) => {
      expect(await infrastructureProblems(client)).toEqual([]);
      // Not vacuous: the worker schema is installed here, and both hold tables.
      const tables = await client.query<{ schema: string }>(
        `select distinct n.nspname as schema
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = any($1::text[]) and c.relkind = 'r'
          order by 1`,
        [[...INFRASTRUCTURE_SCHEMAS]],
      );
      expect(tables.rows.map((row) => row.schema)).toEqual(['graphile_worker', 'ujira_jobs']);
    });
  });

  it.each([
    ['principal_id', 'infrastructure holds no tenant columns'],
    ['project_id', 'infrastructure holds no tenant columns'],
    ['recipient_email', 'reads like personal data, which belongs in recipient_pii'],
  ])('fails a queue table with a column named %s', async (column, why) => {
    await fixtureClient.query(`create table ujira_jobs.fixture_column (${column} text)`);
    try {
      expect(await infrastructureProblems(fixtureClient)).toEqual([
        `ujira_jobs.fixture_column.${column}: ${why}`,
      ]);
    } finally {
      await fixtureClient.query('drop table ujira_jobs.fixture_column');
    }
  });
});

describe('security definer functions', () => {
  it('every one in the database is on the allowlist, and the reverse', async () => {
    await asMigrated(async (client) => {
      expect(await definerProblems(client)).toEqual([]);
    });
  });

  it('the job queue and the cron fan-out are on it', () => {
    expect(DEFINER_ALLOWLIST).toEqual(
      expect.arrayContaining([
        'ujira_jobs.enqueue(text,jsonb,text,text,timestamp with time zone,integer,text,text)',
        'ujira.funding_hold_targets(uuid,uuid,text,integer)',
        'ujira.reconcile_targets(uuid,integer)',
        'ujira.due_attempt_deadlines(timestamp with time zone,integer)',
        'ujira.overdue_fee_refunds(integer)',
      ]),
    );
  });

  it.each(['ujira', 'ujira_jobs', 'ops', 'public'])(
    'fails a fixture definer function in schema %s that is not on the list',
    async (schema) => {
      await fixtureClient.query(
        `create function ${schema}.fixture_definer() returns void
           language sql security definer as 'select 1'`,
      );
      try {
        expect(await definerProblems(fixtureClient)).toEqual([
          `${schema === 'public' ? '' : `${schema}.`}fixture_definer(): a security definer function not on the allowlist`,
        ]);
      } finally {
        await fixtureClient.query(`drop function ${schema}.fixture_definer()`);
      }
    },
  );

  it('fails an allowlist entry that names nothing, so the list cannot go stale', async () => {
    expect(await definerProblems(fixtureClient, [...DEFINER_ALLOWLIST, 'ujira.gone()'])).toEqual([
      'ujira.gone(): on the allowlist, and not in the database',
    ]);
  });

  it('an invoker function is not its concern', async () => {
    await fixtureClient.query(
      `create function ujira.fixture_invoker() returns void language sql as 'select 1'`,
    );
    try {
      expect(await definerProblems(fixtureClient)).toEqual([]);
    } finally {
      await fixtureClient.query('drop function ujira.fixture_invoker()');
    }
  });
});

describe('job payload shapes', () => {
  it('passes ids', () => {
    expect(
      jobPayloadProblems({
        'payout:advance': ['payoutId', 'try'],
        'mandate:reconcile': ['mandateInstanceId'],
        'chain:scan': ['network'],
      }),
    ).toEqual([]);
  });

  it.each(['recipientEmail', 'phone', 'fullName', 'nationalId', 'homeAddress', 'amount', 'note'])(
    'fails a field named %s',
    (field) => {
      expect(jobPayloadProblems({ 'payout:advance': ['payoutId', field] })).toEqual([
        `payout:advance.${field}: a job payload carries ids only`,
      ]);
    },
  );

  it.each(['principalId', 'projectId'])('fails %s, which the database adds itself', (field) => {
    expect(jobPayloadProblems({ 'payout:advance': [field] })).toEqual([
      `payout:advance.${field}: the database adds the tenant ids`,
    ]);
  });
});
