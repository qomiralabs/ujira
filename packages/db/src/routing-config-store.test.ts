// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The routing configuration against real Postgres, as the real roles.
 *
 * - The store meets the same contract as the router's in-memory one.
 * - Services read as the app role through the narrow functions. Writes need
 *   ujira_ops: the app role is refused by the database, and a store with no
 *   write connection refuses before it gets that far.
 * - Two reloaders on one database both apply an activation on their next
 *   poll. An invalid row made active keeps the previous snapshot and alerts.
 *   Activating an older version rolls back.
 * - Versions are append only, and created_by refuses an email address.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { RoutingConfigReloader, activateRoutingConfig, publishRoutingConfig } from '@ujira/router';
import type { RoutingConfigAlerts, RoutingConfigStore } from '@ujira/router';
import { describeRoutingConfigStore, routingDocument } from '@ujira/router/testing';

import { loadDatabaseConfig, opsConnectionConfig } from './config.js';
import { createDatabase, type Database } from './database.js';
import { routingConfig } from './repositories/ops.js';
import { RoutingConfigReadOnlyError, createRoutingConfigStore } from './routing-config-store.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const OPTS = { signal: new AbortController().signal };

let database: TestDatabase;
let app: Database;
let ops: Database;
let admin: pg.Client;
let store: RoutingConfigStore;

function alertsLog() {
  const invalid: Parameters<RoutingConfigAlerts['invalidActiveVersion']>[0][] = [];
  const failed: Parameters<RoutingConfigAlerts['loadFailed']>[0][] = [];
  const alerts: RoutingConfigAlerts = {
    invalidActiveVersion: (e) => invalid.push(e),
    loadFailed: (e) => failed.push(e),
  };
  return { alerts, invalid, failed };
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
  app = databaseAsServiceRoles(roleUrls, database);
  const base = loadDatabaseConfig({
    UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
    UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
    UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_indexer', database.name),
    UJIRA_DB_MIGRATION_URL: database.url,
    UJIRA_DB_TLS: 'off',
  });
  ops = createDatabase(opsConnectionConfig(base, roleUrl(roleUrls, 'ujira_ops', database.name)));
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  store = createRoutingConfigStore({ reads: app, writes: ops });
});

beforeEach(async () => {
  await admin.query('delete from ops.routing_config_active');
});

afterAll(async () => {
  await admin.end();
  await app.close();
  await ops.close();
  await database.drop();
});

describeRoutingConfigStore('the Postgres store', () => Promise.resolve(store));

describe('reloading from Postgres', () => {
  it('applies an activation to two instances within one poll', async () => {
    const first = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'deploy.runbook',
    });
    await activateRoutingConfig(store, first.version);
    const a = new RoutingConfigReloader({ store, alerts: alertsLog().alerts });
    const b = new RoutingConfigReloader({ store, alerts: alertsLog().alerts });
    expect((await a.poll()).kind).toBe('applied');
    expect((await b.poll()).kind).toBe('applied');
    expect(await a.poll()).toEqual({ kind: 'unchanged', version: first.version });

    const next = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'deploy.runbook',
    });
    await activateRoutingConfig(store, next.version);
    await a.poll();
    await b.poll();
    expect(a.current().version).toBe(next.version);
    expect(b.current().version).toBe(next.version);
    expect(a.current().config.rails).toHaveLength(3);
  });

  it('keeps the previous snapshot and alerts when a bad row is made active', async () => {
    const good = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'deploy.runbook',
    });
    await activateRoutingConfig(store, good.version);
    const { alerts, invalid } = alertsLog();
    const reloader = new RoutingConfigReloader({ store, alerts });
    await reloader.poll();

    // Past every check the router makes, as a hand edit in the database would be.
    const bad = await store.insertVersion({ document: { rails: [] }, createdBy: 'by.hand' }, OPTS);
    await store.activate(bad.version, OPTS);
    expect((await reloader.poll()).kind).toBe('rejected');
    expect(reloader.current().version).toBe(good.version);
    expect(invalid.map((e) => e.version)).toEqual([bad.version]);
  });

  it('rolls back by activating an older version', async () => {
    const older = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'deploy.runbook',
    });
    const newer = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'deploy.runbook',
    });
    await activateRoutingConfig(store, newer.version);
    const reloader = new RoutingConfigReloader({ store, alerts: alertsLog().alerts });
    await reloader.poll();
    await activateRoutingConfig(store, older.version);
    expect(await reloader.poll()).toEqual({
      kind: 'applied',
      version: older.version,
      previous: newer.version,
    });
  });

  it('refuses to start before anything is activated', async () => {
    const { alerts, failed } = alertsLog();
    const reloader = new RoutingConfigReloader({ store, alerts });
    await expect(reloader.start()).rejects.toThrow();
    expect(failed.map((e) => e.code)).toEqual(['ROUTING_CONFIG_UNAVAILABLE']);
  });
});

describe('who can write', () => {
  it('the app role cannot write configuration', async () => {
    const { version } = await store.insertVersion({ document: {}, createdBy: 'test' }, OPTS);
    expect(
      await codeOf(
        app.unscoped((tx) => routingConfig.insertVersion(tx, { document: {}, createdBy: 'test' })),
      ),
    ).toBe('42501');
    expect(await codeOf(app.unscoped((tx) => routingConfig.activate(tx, BigInt(version))))).toBe(
      '42501',
    );
    expect(await store.readActivePointer(OPTS)).toBeNull();
  });

  it('a store with no write connection refuses to write, and still reads', async () => {
    const readOnly = createRoutingConfigStore({ reads: app });
    await expect(readOnly.insertVersion({ document: {}, createdBy: 'test' }, OPTS)).rejects.toThrow(
      RoutingConfigReadOnlyError,
    );
    await expect(readOnly.activate(1, OPTS)).rejects.toThrow(RoutingConfigReadOnlyError);
    expect(await readOnly.readActivePointer(OPTS)).toBeNull();
  });

  it('the app role reads through the narrow functions only', async () => {
    const { version } = await store.insertVersion({ document: { a: 1 }, createdBy: 'test' }, OPTS);
    const read = await createRoutingConfigStore({ reads: app }).getVersion(version, OPTS);
    expect(read).toMatchObject({ version, document: { a: 1 }, createdBy: 'test' });
    expect(read?.createdAt).toBeInstanceOf(Date);
  });
});

describe('the table', () => {
  it('keeps versions append only, even for ujira_ops', async () => {
    const { version } = await store.insertVersion({ document: {}, createdBy: 'test' }, OPTS);
    await expect(
      admin.query('delete from ops.routing_config_versions where version = $1', [version]),
    ).rejects.toThrow();
    await expect(
      admin.query(`update ops.routing_config_versions set document = '{}' where version = $1`, [
        version,
      ]),
    ).rejects.toThrow();
  });

  it('refuses an email address as created_by', async () => {
    expect(
      await codeOf(store.insertVersion({ document: {}, createdBy: 'jane@example.com' }, OPTS)),
    ).toBe('23514');
  });

  it('accepts every operator ID the router accepts', async () => {
    await expect(
      publishRoutingConfig(store, { document: routingDocument(), createdBy: 'ops_1-a.b:c' }),
    ).resolves.toBeDefined();
  });
});

describe('the signal', () => {
  it('starts nothing once it is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = { signal: controller.signal };
    await expect(store.readActivePointer(opts)).rejects.toThrow();
    await expect(store.getVersion(1, opts)).rejects.toThrow();
    await expect(store.activate(1, opts)).rejects.toThrow();
    await expect(store.insertVersion({ document: {}, createdBy: 'test' }, opts)).rejects.toThrow();
  });
});
