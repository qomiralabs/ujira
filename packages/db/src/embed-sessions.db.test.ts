// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Embed tokens let the widget touch one recipient from allowed origins for a short
// time. Only their hash is stored, a session is used at most once, and retention
// removes it 7 days after it lapses unless a wallet verification still names it.

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadDatabaseConfig } from './config.js';
import { createDatabase, type Database } from './database.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import {
  destinationVerifications,
  embedSessionRetention,
  embedSessions,
  type NewEmbedSession,
} from './repositories/identity-evidence.js';
import { payoutMethods, recipients } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let retentionDb: Database;
let admin: pg.Client;
let tenant: CreatedPrincipal;
let recipientId: string;

const later = () => new Date(Date.now() + 3_600_000);

function session(change: Partial<NewEmbedSession> = {}): NewEmbedSession {
  return {
    tokenHash: randomBytes(32),
    tokenPrefix: `ujes_test_${randomUUID().slice(0, 8)}`,
    recipientId,
    purpose: 'onboarding',
    allowedOrigins: ['https://app.example'],
    createdByToken: null,
    expiresAt: later(),
    ...change,
  };
}

const create = (change: Partial<NewEmbedSession> = {}) =>
  db.tenant(tenant).transaction(async (tx) => embedSessions.create(tx, session(change)));

const codeOf = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => 'resolved',
    (error: unknown) => (error as { code?: unknown }).code,
  );

const removeBatch = (limit = 1000) =>
  retentionDb.unscoped(async (tx) => embedSessionRetention.deleteBatch(tx, limit), 'worker');

const stillThere = async (id: string) =>
  (await admin.query('select 1 from ujira.embed_sessions where id = $1', [id])).rowCount === 1;

async function lapse(id: string, interval: string): Promise<void> {
  await admin.query(
    `update ujira.embed_sessions set expires_at = now() - $2::interval where id = $1`,
    [id, interval],
  );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database);
  retentionDb = createDatabase(
    loadDatabaseConfig({
      UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
      UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
      UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_retention', database.name),
      UJIRA_DB_MIGRATION_URL: database.url,
      UJIRA_DB_TLS: 'off',
    }),
  );
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
  const recipient = await db
    .tenant(tenant)
    .transaction(async (tx) =>
      recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' }),
    );
  recipientId = recipient.id;
});

afterAll(async () => {
  await admin.end();
  await retentionDb.close();
  await db.close();
  await database.drop();
});

describe('what a session stores', () => {
  it('token column holds a 32-byte hash', async () => {
    const tokenHash = randomBytes(32);
    const created = await create({ tokenHash });
    const { rows } = await admin.query<{ token_hash: Buffer }>(
      'select token_hash from ujira.embed_sessions where id = $1',
      [created.id],
    );
    expect(rows[0]?.token_hash).toEqual(tokenHash);
    expect(await codeOf(create({ tokenHash: randomBytes(31) }))).toBe('23514');
    expect(await codeOf(create({ tokenHash: randomBytes(64) }))).toBe('23514');
  });

  it('never hands the hash back', async () => {
    const created = await create();
    expect(created).not.toHaveProperty('tokenHash');
    expect(created).not.toHaveProperty('token_hash');
  });

  it('refuses a token hash used twice', async () => {
    const tokenHash = randomBytes(32);
    await create({ tokenHash });
    expect(await codeOf(create({ tokenHash }))).toBe('23505');
  });

  it.each(['ujes_prod_abcd1234', 'ujes_test_short', 'uj_test_abcd1234', 'ujes_test_abcd-234'])(
    'refuses the prefix %s',
    async (tokenPrefix) => {
      expect(await codeOf(create({ tokenPrefix }))).toBe('23514');
    },
  );

  it('takes each purpose it knows, and refuses another', async () => {
    for (const purpose of ['onboarding', 'method_change', 'identity'] as const) {
      expect(await codeOf(create({ purpose }))).toBe('resolved');
    }
    expect(await codeOf(create({ purpose: 'payouts' as 'identity' }))).toBe('23514');
  });

  it('takes from 1 to 10 allowed origins', async () => {
    const origins = (count: number) =>
      Array.from({ length: count }, (_, index) => `https://a${String(index)}.example`);
    expect(await codeOf(create({ allowedOrigins: origins(1) }))).toBe('resolved');
    expect(await codeOf(create({ allowedOrigins: origins(10) }))).toBe('resolved');
    expect(await codeOf(create({ allowedOrigins: [] }))).toBe('23514');
    expect(await codeOf(create({ allowedOrigins: origins(11) }))).toBe('23514');
  });

  it('refuses a recipient that does not exist', async () => {
    expect(await codeOf(create({ recipientId: randomUUID() }))).toBe('23503');
  });
});

describe('using a session', () => {
  const consume = (id: string) =>
    db.tenant(tenant).transaction(async (tx) => embedSessions.consume(tx, id));

  it('works once', async () => {
    const { id } = await create();
    expect(await consume(id)).toBe(true);
    expect(await consume(id)).toBe(false);
  });

  it('does not work once lapsed', async () => {
    const { id } = await create();
    await lapse(id, '1 second');
    expect(await consume(id)).toBe(false);
  });

  it('lets only one of many callers through', async () => {
    const { id } = await create();
    const results = await Promise.all([consume(id), consume(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('retention', () => {
  it('deletes a session 7 days after expiry, and no sooner', async () => {
    const old = await create();
    const recent = await create();
    const live = await create();
    await lapse(old.id, '8 days');
    await lapse(recent.id, '6 days');
    await removeBatch();
    expect(await stillThere(old.id)).toBe(false);
    expect(await stillThere(recent.id)).toBe(true);
    expect(await stillThere(live.id)).toBe(true);
  });

  it('keeps a session a wallet verification names, since that evidence is permanent', async () => {
    const named = await create();
    await lapse(named.id, '8 days');
    await db.tenant(tenant).transaction(async (tx) => {
      const method = await payoutMethods.create(tx, {
        recipientId,
        method: 'stellar_wallet',
        rail: 'wallet',
        chain: 'stellar',
        destinationAddress: `G${randomUUID()}`,
        destinationTag: null,
        details: null,
      });
      await destinationVerifications.record(tx, {
        methodId: method.id,
        level: 'wallet_session',
        chain: 'stellar',
        destinationAddress: method.destinationAddress,
        destinationTag: null,
        embedSessionId: named.id,
      });
    });
    await expect(removeBatch()).resolves.toBeGreaterThanOrEqual(0);
    expect(await stillThere(named.id)).toBe(true);
  });

  it('takes one batch at a time', async () => {
    const sessions = [await create(), await create(), await create()];
    for (const { id } of sessions) await lapse(id, '8 days');
    expect(await removeBatch(2)).toBe(2);
    expect(await removeBatch(2)).toBe(1);
    expect(await removeBatch(2)).toBe(0);
  });

  it('cannot read a token hash, or a session still inside its window', async () => {
    const recent = await create();
    const client = new pg.Client({
      connectionString: roleUrl(roleUrls, 'ujira_retention', database.name),
    });
    await client.connect();
    try {
      expect(await codeOf(client.query('select token_hash from ujira.embed_sessions'))).toBe(
        '42501',
      );
      expect(await codeOf(client.query('select recipient_id from ujira.embed_sessions'))).toBe(
        '42501',
      );
      const { rows } = await client.query<{ id: string }>(
        'select id from ujira.embed_sessions where id = $1',
        [recent.id],
      );
      expect(rows).toEqual([]);
      const removed = await client.query('delete from ujira.embed_sessions where id = $1', [
        recent.id,
      ]);
      expect(removed.rowCount).toBe(0);
      expect(await codeOf(client.query(`update ujira.embed_sessions set expires_at = now()`))).toBe(
        '42501',
      );
    } finally {
      await client.end();
    }
  });
});
