// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// ujira.attestation_pending is how the attester signer checks that the
// identity service recorded an attestation first. Only that signer's own login
// may call it, it runs as a role of its own with a fixed search path, and until
// the attestation log exists it returns no rows, so the signer refuses
// everything.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createTestDatabase,
  roleUrl,
  type LoginRole,
  type TestDatabase,
} from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const CALL = 'select * from ujira.attestation_pending($1::bytea)';
const DIGEST = Buffer.alloc(32, 7);

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
});

afterAll(async () => {
  await database.drop();
});

async function as<T>(role: LoginRole, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(roleUrls, role, database.name) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('ujira.attestation_pending', () => {
  it('app role gets permission denied', async () => {
    expect(await as('ujira_app', (client) => codeOf(client.query(CALL, [DIGEST])))).toBe('42501');
  });

  it.each<LoginRole>([
    'ujira_reader',
    'ujira_retention',
    'ujira_auth',
    'ujira_indexer',
    'ujira_ops',
  ])('%s gets permission denied', async (role) => {
    expect(await as(role, (client) => codeOf(client.query(CALL, [DIGEST])))).toBe('42501');
  });

  it('returns no rows before the attestation log exists', async () => {
    const result = await as('ujira_signer_attester', (client) => client.query(CALL, [DIGEST]));
    expect(result.rows).toEqual([]);
    expect(result.fields.map((field) => field.name)).toEqual([
      'principal_id',
      'project_id',
      'attestation_id',
    ]);
  });

  it('runs as its own narrow role, with a fixed search path', async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      const { rows } = await client.query<{
        owner: string;
        definer: boolean;
        config: string[];
        volatility: string;
      }>(
        `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
                p.proconfig as config, p.provolatile as volatility
           from pg_proc p where p.oid = 'ujira.attestation_pending(bytea)'::regprocedure`,
      );
      expect(rows).toEqual([
        {
          owner: 'ujira_signer_read',
          definer: true,
          config: ['search_path=pg_catalog'],
          volatility: 's',
        },
      ]);
      const role = await client.query<{ login: boolean; bypass: boolean }>(
        `select rolcanlogin as login, rolbypassrls as bypass from pg_roles
          where rolname = 'ujira_signer_read'`,
      );
      expect(role.rows).toEqual([{ login: false, bypass: false }]);
    } finally {
      await client.end();
    }
  });

  it('gives the signer login nothing but this function', async () => {
    const tables = await as('ujira_signer_attester', (client) =>
      codeOf(client.query('select * from ujira.principals')),
    );
    expect(tables).toBe('42501');
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ fn: string }>(
        `select p.oid::regprocedure::text as fn
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where n.nspname = 'ujira'
            and a.privilege_type = 'EXECUTE'
            and a.grantee = 'ujira_signer_attester'::regrole`,
      );
      expect(rows.map((row) => row.fn)).toEqual(['ujira.attestation_pending(bytea)']);
    } finally {
      await client.end();
    }
  });
});
