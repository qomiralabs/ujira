// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A replayed webhook must never change state twice. A delivery arrives before
// anyone can know whose it is, so these rows live in schema ops, with no tenant,
// and the app reaches them only through two narrow functions.

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { identityProviderEvents } from './repositories/ops.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;

function event(overrides: Partial<Parameters<typeof identityProviderEvents.record>[1]> = {}) {
  return {
    provider: 'self',
    providerAccount: 'test:flow_prekyc',
    eventKey: `ver_${randomUUID()}-completed`,
    rawSha256: randomBytes(32),
    ...overrides,
  };
}

const record = (input: ReturnType<typeof event>) =>
  db.unscoped(async (tx) => identityProviderEvents.record(tx, input));

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function asOwner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('identity provider events', () => {
  it('the same event key is stored once', async () => {
    const first = event();
    expect(await record(first)).toBe(true);
    expect(await record({ ...first, rawSha256: randomBytes(32) })).toBe(false);
    const stored = await asOwner((client) =>
      client.query<{ raw_sha256: Buffer }>(
        'select raw_sha256 from ops.identity_provider_events where event_key = $1',
        [first.eventKey],
      ),
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.raw_sha256.equals(first.rawSha256)).toBe(true);
  });

  it('twenty concurrent deliveries store it once', async () => {
    const first = event();
    const results = await Promise.all(Array.from({ length: 20 }, () => record(first)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a key is unique per provider and account, not across them', async () => {
    const first = event();
    expect(await record(first)).toBe(true);
    expect(await record({ ...first, providerAccount: 'test:flow_other' })).toBe(true);
    expect(await record({ ...first, provider: 'sep12' })).toBe(true);
  });

  it('reports whether a key has been seen', async () => {
    const first = event();
    const key = {
      provider: first.provider,
      providerAccount: first.providerAccount,
      eventKey: first.eventKey,
    };
    const seen = () => db.unscoped(async (tx) => identityProviderEvents.seen(tx, key));
    expect(await seen()).toBe(false);
    await record(first);
    expect(await seen()).toBe(true);
  });

  it('refuses anything but opaque tokens and a 32 byte digest', async () => {
    expect(await codeOf(record(event({ eventKey: 'jane@example.com' })))).toBe('23514');
    expect(await codeOf(record(event({ providerAccount: 'has space' })))).toBe('23514');
    expect(await codeOf(record(event({ provider: 'Self Enterprise' })))).toBe('23514');
    expect(await codeOf(record(event({ rawSha256: randomBytes(31) })))).toBe('23514');
  });

  it('is append only, even for the owner of the table', async () => {
    const first = event();
    await record(first);
    await asOwner(async (client) => {
      await client.query('set role ujira_owner');
      expect(
        await codeOf(client.query('update ops.identity_provider_events set received_at = now()')),
      ).toBe('UJ002');
      expect(await codeOf(client.query('delete from ops.identity_provider_events'))).toBe('UJ002');
      expect(await codeOf(client.query('truncate ops.identity_provider_events'))).toBe('UJ002');
    });
  });

  it('the app reaches the table only through the functions', async () => {
    const client = new pg.Client({
      connectionString: roleUrl(roleUrls, 'ujira_app', database.name),
    });
    await client.connect();
    try {
      expect(await codeOf(client.query('select * from ops.identity_provider_events'))).toBe(
        '42501',
      );
      const insert = client.query(
        `insert into ops.identity_provider_events
           (provider, provider_account, event_key, raw_sha256)
         values ('self', 'a', 'b', $1)`,
        [randomBytes(32)],
      );
      expect(await codeOf(insert)).toBe('42501');
    } finally {
      await client.end();
    }
  });
});
