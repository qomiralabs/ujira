// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { entryPoints } from './repositories/entry-points.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { crossSchemaKeys, opsCatalogProblems, opsDataProblems } from './testing/ops-catalog.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let clean: TestDatabase;
let fixtures: TestDatabase;
let cleanClient: pg.Client;
let fixtureClient: pg.Client;

beforeAll(async () => {
  clean = await createTestDatabase(adminUrl, import.meta.url);
  fixtures = await createTestDatabase(adminUrl, `${import.meta.url}#fixtures`);
  cleanClient = new pg.Client({ connectionString: clean.url });
  await cleanClient.connect();
  fixtureClient = new pg.Client({ connectionString: fixtures.url });
  await fixtureClient.connect();
});

afterAll(async () => {
  await fixtureClient.end();
  await cleanClient.end();
  await fixtures.drop();
  await clean.drop();
});

describe('the ops exception', () => {
  it('holds for the migrated schema', async () => {
    expect(await opsCatalogProblems(cleanClient)).toEqual([]);
  });

  it('fails on a fixture column named recipient_email', async () => {
    await fixtureClient.query('create table ops.fixture_email (recipient_email text)');
    expect(await opsCatalogProblems(fixtureClient)).toEqual([
      'ops.fixture_email.recipient_email: the name reads like personal data',
    ]);
    await fixtureClient.query('drop table ops.fixture_email');
  });

  it.each(['full_name', 'phone', 'home_address', 'country', 'id_document'])(
    'fails on a column named %s',
    async (column) => {
      await fixtureClient.query(`create table ops.fixture_named (${column} text)`);
      expect(await opsCatalogProblems(fixtureClient)).toEqual([
        `ops.fixture_named.${column}: the name reads like personal data`,
      ]);
      await fixtureClient.query('drop table ops.fixture_named');
    },
  );

  it('does not trip on a word that only contains one of the patterns', async () => {
    await fixtureClient.query('create table ops.fixture_words (renamed_at text, addressable text)');
    expect(await opsCatalogProblems(fixtureClient)).toEqual([]);
    await fixtureClient.query('drop table ops.fixture_words');
  });

  it('fails on a comment that reads like personal data', async () => {
    await fixtureClient.query(`
      create table ops.fixture_comment (holder text);
      comment on column ops.fixture_comment.holder is 'the email of the person holding it';
    `);
    expect(await opsCatalogProblems(fixtureClient)).toEqual([
      'ops.fixture_comment.holder: the comment reads like personal data',
    ]);
    await fixtureClient.query('drop table ops.fixture_comment');
  });

  it('fails on a tenant column', async () => {
    await fixtureClient.query(
      'create table ops.fixture_tenant (principal_id uuid, project_id uuid)',
    );
    expect(await opsCatalogProblems(fixtureClient)).toEqual([
      'ops.fixture_tenant.principal_id: is a tenant column',
      'ops.fixture_tenant.project_id: is a tenant column',
    ]);
    await fixtureClient.query('drop table ops.fixture_tenant');
  });
});

describe('cross references', () => {
  it('no foreign keys between ops and ujira', async () => {
    expect(await crossSchemaKeys(cleanClient)).toEqual([]);
  });

  it('finds one in either direction', async () => {
    await fixtureClient.query(`
      create table ops.fixture_to_ujira (chain text references ujira.chains (code));
      create table ujira.fixture_to_ops (network text references ops.chain_cursors (network));
    `);
    expect(await crossSchemaKeys(fixtureClient)).toEqual([
      expect.stringMatching(/^ops\.fixture_to_ujira: foreign key \S+ crosses to ujira\.chains$/),
      expect.stringMatching(
        /^ujira\.fixture_to_ops: foreign key \S+ crosses to ops\.chain_cursors$/,
      ),
    ]);
    await fixtureClient.query(`
      drop table ops.fixture_to_ujira;
      drop table ujira.fixture_to_ops;
    `);
  });
});

describe('the rows', () => {
  it('finds no tenant identifier in ordinary ops rows, and finds one that is planted', async () => {
    const db = databaseAsServiceRoles(roleUrls, fixtures);
    try {
      const created = await db.unscoped(async (tx) =>
        entryPoints.createPrincipal(tx, {
          name: 'Acme',
          projectName: 'Main',
          ownerUserId: randomUUID(),
        }),
      );
      await fixtureClient.query(
        `insert into ops.executor_accounts (network, account_ref, lease_holder, lease_expires_at)
         values ('stellar:testnet', 'GABC', 'worker-1', now())`,
      );
      await fixtureClient.query(
        `insert into ops.routing_config_versions (document, created_by)
         values ('{"corridors":[]}', 'deploy.runbook')`,
      );
      expect(await opsDataProblems(fixtureClient)).toEqual([]);

      // A worker that names its lease after the project it is working for
      // has put a tenant identifier in a table that promises to hold none.
      await fixtureClient.query(`update ops.executor_accounts set lease_holder = $1`, [
        `worker-for-${created.projectId}`,
      ]);
      expect(await opsDataProblems(fixtureClient)).toEqual([
        'ops.executor_accounts: 1 row(s) hold an identifier of a tenant row',
      ]);
      // And inside a JSON document, which a column check would never see.
      await fixtureClient.query(
        `insert into ops.routing_config_versions (document, created_by) values ($1, 'deploy.runbook')`,
        [JSON.stringify({ overrides: { [created.principalId]: 'stellar' } })],
      );
      expect(await opsDataProblems(fixtureClient)).toEqual([
        'ops.executor_accounts: 1 row(s) hold an identifier of a tenant row',
        'ops.routing_config_versions: 1 row(s) hold an identifier of a tenant row',
      ]);
    } finally {
      await db.close();
    }
  });
});
