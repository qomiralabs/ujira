// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// ops.signing_keys is the record of every infrastructure key: what it is for,
// where it lives and the account it must control. Never the key itself. The
// operations login writes it, and the app can only read the active rows
// through one narrow function.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import { signingKeys } from './repositories/signers.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const NETWORK = 'stellar:testnet';
const PUBLIC_KEY = Buffer.alloc(32, 7);

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let ops: pg.Client;
let sequence = 0;

interface Row {
  readonly purpose: string;
  readonly network: string | null;
  readonly anchor_id: string | null;
  readonly provider: string;
  readonly key_ref: string;
  readonly address: string | null;
  readonly public_key: Buffer | null;
}

function row(change: Partial<Row> = {}): Row {
  sequence += 1;
  return {
    purpose: 'executor',
    network: NETWORK,
    anchor_id: null,
    provider: 'aws_kms',
    key_ref: `alias/executor-${String(sequence)}`,
    address: `G${String(sequence).padStart(55, 'A')}`,
    public_key: PUBLIC_KEY,
    ...change,
  };
}

function insert(values: Row) {
  return ops.query<{ id: string }>(
    `insert into ops.signing_keys (purpose, network, anchor_id, provider, key_ref, address, public_key)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      values.purpose,
      values.network,
      values.anchor_id,
      values.provider,
      values.key_ref,
      values.address,
      values.public_key,
    ],
  );
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
  db = databaseAsServiceRoles(roleUrls, database);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  ops = new pg.Client({ connectionString: roleUrl(roleUrls, 'ujira_ops', database.name) });
  await ops.connect();
});

afterAll(async () => {
  await ops.end();
  await admin.end();
  await db.close();
  await database.drop();
});

describe('ops.signing_keys', () => {
  it('columns hold references and addresses only', async () => {
    const { rows } = await admin.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'ops' and table_name = 'signing_keys' order by ordinal_position`,
    );
    expect(rows).toEqual([
      { column_name: 'id', data_type: 'bigint' },
      { column_name: 'purpose', data_type: 'text' },
      { column_name: 'network', data_type: 'text' },
      { column_name: 'anchor_id', data_type: 'text' },
      { column_name: 'provider', data_type: 'text' },
      { column_name: 'key_ref', data_type: 'text' },
      { column_name: 'address', data_type: 'text' },
      { column_name: 'public_key', data_type: 'bytea' },
      { column_name: 'status', data_type: 'text' },
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone' },
    ]);
    // Neither key table can hold a private key by any name, in either schema.
    const { rows: secretish } = await admin.query<{ column: string }>(
      `select table_schema || '.' || table_name || '.' || column_name as column
         from information_schema.columns
        where (table_schema, table_name) in (('ops', 'signing_keys'), ('ujira', 'managed_signers'))
          and column_name ~* '(secret|private|seed|mnemonic|plaintext|wrapped|ciphertext|passphrase)'`,
    );
    expect(secretish).toEqual([]);
    // The one bytes column is a public key, exactly 32 bytes. A private key
    // in its 64 byte expanded form does not fit.
    expect(await codeOf(insert(row({ public_key: Buffer.alloc(64) })))).toBe('23514');
  });

  it.each([
    ['a Stellar secret seed', `S${'A'.repeat(55)}`],
    ['a URL', 'https://kms.example/key'],
    ['something with spaces', 'not a key name'],
  ])('refuses %s as a key reference', async (_label, key_ref) => {
    expect(await codeOf(insert(row({ key_ref })))).toBe('23514');
  });

  it('sep10 without anchor_id is refused', async () => {
    expect(await codeOf(insert(row({ purpose: 'sep10' })))).toBe('23514');
    await insert(row({ purpose: 'sep10', anchor_id: 'anchor.example' }));
  });

  it('refuses an anchor on any other key', async () => {
    expect(await codeOf(insert(row({ anchor_id: 'anchor.example' })))).toBe('23514');
  });

  it('requires a network, an account and a public key, except on the key encryption key', async () => {
    for (const change of [{ network: null }, { address: null }, { public_key: null }]) {
      expect(await codeOf(insert(row(change)))).toBe('23514');
    }
    const kek = { purpose: 'pii_kek', network: null, address: null, public_key: null };
    await insert(row(kek));
    expect(await codeOf(insert(row({ ...kek, network: NETWORK })))).toBe('23514');
    expect(await codeOf(insert(row({ ...kek, public_key: PUBLIC_KEY })))).toBe('23514');
  });

  it.each([
    ['purpose', { purpose: 'other' }],
    ['provider', { provider: 'other' }],
    ['network', { network: 'not a network' }],
  ])('refuses an unknown %s', async (_label, change) => {
    expect(await codeOf(insert(row(change)))).toBe('23514');
  });

  it('keeps one active row per purpose, network, anchor and key', async () => {
    const first = row();
    await insert(first);
    expect(await codeOf(insert({ ...first, address: 'GOTHER' }))).toBe('23505');
    // Another key under the same purpose is the executor pool.
    await insert(row());
    const anchored = row({ purpose: 'sep10', anchor_id: 'one.example' });
    await insert(anchored);
    await insert({ ...anchored, anchor_id: 'two.example' });
    expect(await codeOf(insert(anchored))).toBe('23505');
    // The key encryption key has no network to tell two rows apart by.
    const kek = row({ purpose: 'pii_kek', network: null, address: null, public_key: null });
    await insert(kek);
    expect(await codeOf(insert(kek))).toBe('23505');
  });

  it('moves only forward, and keeps what it names', async () => {
    const { rows } = await insert(row());
    const id = rows[0]?.id;
    const set = (assignment: string) =>
      ops.query(`update ops.signing_keys set ${assignment} where id = $1`, [id]);
    expect(await codeOf(set(`key_ref = 'alias/other'`))).toBe('UJ006');
    expect(await codeOf(set(`address = 'GOTHER'`))).toBe('UJ006');
    // The trigger runs before the check constraint, so this is its refusal.
    expect(await codeOf(set(`status = 'bogus'`))).toBe('UJ004');
    await set(`status = 'retiring'`);
    expect(await codeOf(set(`status = 'active'`))).toBe('UJ004');
    await set(`status = 'retired'`);
    expect(await codeOf(set(`status = 'retiring'`))).toBe('UJ004');
    // A row that does not change its status passes the check.
    await set(`updated_at = now()`);
  });

  it('allows a key to retire at once', async () => {
    const { rows } = await insert(row());
    await ops.query(`update ops.signing_keys set status = 'retired' where id = $1`, [rows[0]?.id]);
  });

  it('cannot be deleted, even by the operations login', async () => {
    expect(await codeOf(ops.query('delete from ops.signing_keys'))).toBe('42501');
  });

  it('gives the app nothing but the read function', async () => {
    const app = new pg.Client({ connectionString: roleUrl(roleUrls, 'ujira_app', database.name) });
    await app.connect();
    try {
      expect(await codeOf(app.query('select * from ops.signing_keys'))).toBe('42501');
      expect(await codeOf(app.query(`delete from ops.signing_keys`))).toBe('42501');
    } finally {
      await app.end();
    }
    for (const role of [
      'ujira_reader',
      'ujira_retention',
      'ujira_auth',
      'ujira_indexer',
    ] as const) {
      const client = new pg.Client({ connectionString: roleUrl(roleUrls, role, database.name) });
      await client.connect();
      try {
        expect(await codeOf(client.query(`select ops.active_signing_keys('{}')`)), role).toBe(
          '42501',
        );
      } finally {
        await client.end();
      }
    }
  });

  it('reads back the active keys of the purposes asked for', async () => {
    const marker = randomUUID();
    const sponsor = row({ purpose: 'fee_sponsor', key_ref: `alias/sponsor-${marker}` });
    await insert(sponsor);
    const anchor = row({
      purpose: 'sep10',
      anchor_id: 'read.example',
      key_ref: `alias/sep10-${marker}`,
    });
    await insert(anchor);
    const attester = row({ purpose: 'attester', key_ref: `alias/attester-${marker}` });
    const retired = await insert(attester);
    await ops.query(`update ops.signing_keys set status = 'retired' where id = $1`, [
      retired.rows[0]?.id,
    ]);
    const kek = row({
      purpose: 'pii_kek',
      network: null,
      address: null,
      public_key: null,
      key_ref: `alias/kek-${marker}`,
    });
    await insert(kek);

    const read = await db.unscoped(async (tx) =>
      signingKeys.active(tx, ['fee_sponsor', 'sep10', 'attester', 'pii_kek']),
    );
    const mine = read.filter((key) => key.keyRef.endsWith(marker));
    expect(mine).toEqual([
      {
        purpose: 'fee_sponsor',
        network: NETWORK,
        anchorId: null,
        provider: 'aws_kms',
        keyRef: sponsor.key_ref,
        address: sponsor.address,
        publicKey: Uint8Array.from(PUBLIC_KEY),
      },
      {
        purpose: 'sep10',
        network: NETWORK,
        anchorId: 'read.example',
        provider: 'aws_kms',
        keyRef: anchor.key_ref,
        address: anchor.address,
        publicKey: Uint8Array.from(PUBLIC_KEY),
      },
      {
        purpose: 'pii_kek',
        network: null,
        anchorId: null,
        provider: 'aws_kms',
        keyRef: kek.key_ref,
        address: null,
        publicKey: null,
      },
    ]);
    expect(await db.unscoped(async (tx) => signingKeys.active(tx, ['executor']))).not.toEqual(mine);
  });
});
