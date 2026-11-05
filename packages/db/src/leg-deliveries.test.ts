// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One record of each delivery step, whatever the rail. The sponsorship and signing tables
// are here too, because they are small and share the same rule: a retry finds the first.

import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  chainRetention,
  legDeliveries,
  signingRequests,
  sponsorshipLedger,
  type LegDelivery,
} from './repositories/chain-store.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const AT = new Date('2026-11-05T00:00:00.000Z');

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let tenant: CreatedPrincipal;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function legKey(): string {
  return `0x${randomBytes(33).toString('hex')}`;
}

function delivery(overrides: Partial<LegDelivery> = {}): LegDelivery {
  return {
    legKey: legKey(),
    network: 'stellar:testnet',
    rail: 'stellar.wallet',
    provider: 'wallet',
    providerRef: 'ref-1',
    destinationAddress: 'GRECIPIENT',
    destinationTag: 7n,
    quoteId: null,
    state: 'in_transit',
    rawStatus: null,
    live: true,
    expiresAt: null,
    updatedAt: AT,
    ...overrides,
  };
}

async function upsert(input: LegDelivery) {
  return db.tenant(tenant).transaction(async (tx) => legDeliveries.upsert(tx, input));
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

beforeEach(async () => {
  tenant = await db.unscoped(async (tx) =>
    entryPoints.createPrincipal(tx, {
      name: 'Acme',
      projectName: 'Main',
      ownerUserId: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('leg deliveries', () => {
  it('upsert on the same leg key, provider and reference updates one row', async () => {
    const first = delivery();
    expect(await upsert(first)).toBe(true);
    const moved = { ...first, state: 'delivered', rawStatus: 'completed' };
    expect(await upsert(moved)).toBe(true);
    const rows = await admin.query('select id from ujira.leg_deliveries where leg_key = $1', [
      first.legKey,
    ]);
    expect(rows.rowCount).toBe(1);
    const live = await db
      .tenant(tenant)
      .transaction(async (tx) => legDeliveries.live(tx, first.legKey));
    expect(live).toEqual(moved);
  });

  it('treats a missing reference as one reference', async () => {
    const first = delivery({ providerRef: null });
    await upsert(first);
    await upsert({ ...first, state: 'delivered' });
    const rows = await admin.query('select state from ujira.leg_deliveries where leg_key = $1', [
      first.legKey,
    ]);
    expect(rows.rows).toEqual([{ state: 'delivered' }]);
  });

  it('a second live record for a leg key and provider is refused', async () => {
    const first = delivery();
    await upsert(first);
    expect(await codeOf(upsert({ ...first, providerRef: 'ref-2' }))).toBe('23505');
    expect(await upsert({ ...first, providerRef: 'ref-3', live: false })).toBe(true);
    expect(await upsert({ ...first, provider: 'partner-b', providerRef: 'ref-4' })).toBe(true);
  });

  it('holds no column for one kind of rail', async () => {
    const columns = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'ujira' and table_name = 'leg_deliveries'
          and column_name ~ 'pickup|anchor|fx_|receive_|cashout|delivery_method'`,
    );
    expect(columns.rows).toEqual([]);
  });

  it.each([
    ['an unknown state', { state: 'lost' }],
    ['a leg key of the wrong length', { legKey: '0x12' }],
    ['an unknown network', { network: 'stellar:mainnet' }],
    ['a tag past 2^64 - 1', { destinationTag: 2n ** 64n }],
  ])('refuses %s', async (_name, overrides) => {
    expect(await codeOf(upsert(delivery(overrides)))).toBe('23514');
  });

  it('refuses a change to the destination, for the superuser too', async () => {
    const first = delivery();
    await upsert(first);
    const change = admin.query(
      `update ujira.leg_deliveries set destination_address = 'GOTHER' where leg_key = $1`,
      [first.legKey],
    );
    expect(await codeOf(change)).toBe('UJ002');
  });

  it('dates a raw status, so retention can clear it', async () => {
    const first = delivery({ rawStatus: 'pending_external' });
    await upsert(first);
    const rows = await admin.query<{ raw_status_at: Date }>(
      'select raw_status_at from ujira.leg_deliveries where leg_key = $1',
      [first.legKey],
    );
    expect(rows.rows[0]?.raw_status_at).toEqual(AT);
  });
});

describe('retention', () => {
  let retention: pg.Client;

  beforeAll(async () => {
    retention = new pg.Client({ connectionString: database.url });
    await retention.connect();
    await retention.query('set role ujira_retention');
  });

  afterAll(async () => {
    await retention.end();
  });

  async function age(table: string, column: string, days: number, where: string, value: string) {
    // These columns refuse a change, so ageing a row takes the triggers off.
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(
      `update ujira.${table} set ${column} = now() - make_interval(days => $1) where ${where} = $2`,
      [days, value],
    );
    await admin.query('commit');
  }

  it('clears a raw status after 90 days and not before', async () => {
    const old = delivery({ rawStatus: 'old' });
    const young = delivery({ rawStatus: 'young' });
    await upsert(old);
    await upsert(young);
    await age('leg_deliveries', 'raw_status_at', 91, 'leg_key', old.legKey);
    await age('leg_deliveries', 'raw_status_at', 89, 'leg_key', young.legKey);

    const result = await retention.query<{ cleared: string }>(
      'select ujira.clear_stale_delivery_status(1000) as cleared',
    );
    expect(result.rows[0]?.cleared).toBe('1');
    const rows = await admin.query<{ raw_status: string | null; raw_status_at: Date | null }>(
      'select raw_status, raw_status_at from ujira.leg_deliveries where leg_key = any($1) order by leg_key = $2',
      [[old.legKey, young.legKey], young.legKey],
    );
    expect(rows.rows[0]).toEqual({ raw_status: null, raw_status_at: null });
    expect(rows.rows[1]?.raw_status).toBe('young');
  });

  it('deletes a signing request 7 days after it could last be signed, and not before', async () => {
    const tenantTx = db.tenant(tenant);
    const record = async (requestId: string) =>
      tenantTx.transaction(async (tx) =>
        signingRequests.record(tx, {
          requestId,
          network: 'stellar:testnet',
          signer: 'GSIGNER',
          request: { kind: 'transaction' },
          validUntil: AT,
        }),
      );
    const old = randomUUID();
    const young = randomUUID();
    await record(old);
    await record(young);
    await age('signing_requests', 'valid_until', 8, 'request_id', old);
    await age('signing_requests', 'valid_until', 6, 'request_id', young);

    const result = await retention.query<{ deleted: string }>(
      'select ujira.delete_stale_signing_requests(1000) as deleted',
    );
    expect(result.rows[0]?.deleted).toBe('1');
    const found = await tenantTx.transaction(async (tx) => [
      await signingRequests.get(tx, old),
      await signingRequests.get(tx, young),
    ]);
    expect(found[0]).toBeUndefined();
    expect(found[1]?.requestId).toBe(young);
  });

  it.each([
    ['clear_stale_delivery_status', 0],
    ['delete_stale_signing_requests', 10001],
  ])('%s refuses a limit of %i', async (fn, limit) => {
    expect(await codeOf(retention.query(`select ujira.${fn}($1)`, [limit]))).toBe('22023');
  });

  it('is out of reach of the app', async () => {
    const attempt = db
      .tenant(tenant)
      .transaction(async (tx) => chainRetention.deleteSigningRequests(tx, 10));
    expect(await codeOf(attempt)).toBe('42501');
  });
});

describe('sponsorship reservations', () => {
  const reservation = {
    network: 'stellar:testnet',
    intent: 'recipient_activation',
    nativeAsset: 'XLM',
    scale: 7,
    maxFee: 1_000_000n,
  };

  async function reserve(reservationId: string) {
    return db
      .tenant(tenant)
      .transaction(async (tx) => sponsorshipLedger.reserve(tx, { ...reservation, reservationId }));
  }

  it('accepts recipient_activation, and a retry finds the first', async () => {
    const id = randomUUID();
    const first = await reserve(id);
    expect(first.created).toBe(true);
    expect(first.sponsorship).toMatchObject({
      state: 'reserved',
      actualFee: null,
      maxFee: 1_000_000n,
    });
    expect((await reserve(id)).created).toBe(false);
  });

  it('settles once, with the fee it cost', async () => {
    const id = randomUUID();
    await reserve(id);
    const session = db.tenant(tenant);
    const settled = await session.transaction(async (tx) => sponsorshipLedger.settle(tx, id, 700n));
    expect(settled).toMatchObject({ state: 'settled', actualFee: 700n });
    expect(
      await session.transaction(async (tx) => sponsorshipLedger.settle(tx, id, 1n)),
    ).toBeUndefined();
    expect(
      await session.transaction(async (tx) => sponsorshipLedger.release(tx, id)),
    ).toBeUndefined();
  });

  it('releases with nothing spent', async () => {
    const id = randomUUID();
    await reserve(id);
    const released = await db
      .tenant(tenant)
      .transaction(async (tx) => sponsorshipLedger.release(tx, id));
    expect(released).toMatchObject({ state: 'released', actualFee: null });
  });

  it('refuses an intent it does not know, and any other change', async () => {
    const attempt = db.tenant(tenant).transaction(async (tx) =>
      sponsorshipLedger.reserve(tx, {
        ...reservation,
        reservationId: randomUUID(),
        intent: 'lunch',
      }),
    );
    expect(await codeOf(attempt)).toBe('23514');
    const id = randomUUID();
    await reserve(id);
    expect(
      await codeOf(
        admin.query(
          `update ujira.sponsorship_ledger set max_fee_native = 1 where reservation_id = $1`,
          [id],
        ),
      ),
    ).toBe('UJ002');
    expect(
      await codeOf(
        admin.query('delete from ujira.sponsorship_ledger where reservation_id = $1', [id]),
      ),
    ).toBe('UJ002');
  });
});

describe('signing requests', () => {
  async function recorded(): Promise<string> {
    const requestId = randomUUID();
    await db.tenant(tenant).transaction(async (tx) =>
      signingRequests.record(tx, {
        requestId,
        network: 'stellar:testnet',
        signer: 'GSIGNER',
        request: { kind: 'transaction', payload: 'AAAA' },
        validUntil: AT,
      }),
    );
    return requestId;
  }

  it('reloads what the wallet was asked to sign', async () => {
    const requestId = await recorded();
    const found = await db
      .tenant(tenant)
      .transaction(async (tx) => signingRequests.get(tx, requestId));
    expect(found).toMatchObject({
      requestId,
      signer: 'GSIGNER',
      request: { kind: 'transaction', payload: 'AAAA' },
      validUntil: AT,
      consumedAt: null,
    });
  });

  it('is consumed once, however many race', async () => {
    const requestId = await recorded();
    const results = await Promise.all(
      Array.from({ length: 10 }, async () =>
        db.tenant(tenant).transaction(async (tx) => signingRequests.consume(tx, requestId)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses setting consumed_at a second time, or changing anything else, for the superuser too', async () => {
    const requestId = await recorded();
    await db.tenant(tenant).transaction(async (tx) => signingRequests.consume(tx, requestId));
    expect(
      await codeOf(
        admin.query(`update ujira.signing_requests set consumed_at = null where request_id = $1`, [
          requestId,
        ]),
      ),
    ).toBe('UJ002');
    expect(
      await codeOf(
        admin.query(`update ujira.signing_requests set signer = 'GOTHER' where request_id = $1`, [
          requestId,
        ]),
      ),
    ).toBe('UJ002');
  });
});
