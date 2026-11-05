// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A submission only moves forward, and every move leaves a record, so what happened to a
// transaction can always be read back after a crash.

import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  chainSubmissions,
  type ChainSubmission,
  type NewChainSubmission,
} from './repositories/chain-store.js';
import { entryPoints, type CreatedPrincipal } from './repositories/entry-points.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const STATES = [
  'built',
  'broadcast',
  'unknown',
  'landed',
  'failed',
  'expired',
  'replaced',
] as const;

const ALLOWED: readonly (readonly [string, string])[] = [
  ['built', 'broadcast'],
  ['broadcast', 'landed'],
  ['broadcast', 'failed'],
  ['broadcast', 'unknown'],
  ['broadcast', 'expired'],
  ['broadcast', 'replaced'],
  ['unknown', 'landed'],
  ['unknown', 'failed'],
  ['unknown', 'expired'],
];

function isAllowed(from: string, to: string): boolean {
  return ALLOWED.some(([a, b]) => a === from && b === to);
}

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

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function newSubmission(overrides: Partial<NewChainSubmission> = {}): NewChainSubmission {
  return {
    network: 'stellar:testnet',
    txHash: hex(32),
    op: 'request',
    mandate: 'CMANDATE',
    payoutId: `0x${hex(32)}`,
    attempt: 1,
    signerAddress: 'GSIGNER',
    sequenceOrNonce: 1n,
    maxTime: null,
    replacesTxHash: null,
    submittedAtLedger: null,
    reservationId: null,
    correlationId: 'corr',
    createdAt: new Date('2026-11-05T00:00:00.000Z'),
    ...overrides,
  };
}

async function record(overrides: Partial<NewChainSubmission> = {}): Promise<ChainSubmission> {
  return db
    .tenant(tenant)
    .transaction(async (tx) => chainSubmissions.record(tx, newSubmission(overrides)));
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
      ownerUserId: crypto.randomUUID(),
    }),
  );
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

describe('the submission machine', () => {
  it('lists exactly the allowed moves', async () => {
    const rows = await admin.query<{ from_status: string; to_status: string }>(
      `select from_status, to_status from ujira.status_transitions where machine = 'chain_submission'`,
    );
    expect(rows.rows.map((row) => `${row.from_status}>${row.to_status}`).sort()).toEqual(
      ALLOWED.map(([from, to]) => `${from}>${to}`).sort(),
    );
  });

  it('every allowed move passes and writes one event, and every other fails', async () => {
    const created = await record();
    await admin.query('begin');
    try {
      for (const from of STATES) {
        for (const to of STATES.filter((state) => state !== from)) {
          await admin.query('savepoint pair');
          await admin.query('set local session_replication_role = replica');
          await admin.query('update ujira.chain_submissions set state = $1 where id = $2', [
            from,
            created.id,
          ]);
          await admin.query('set local session_replication_role = origin');
          const before = await admin.query(
            'select id from ujira.chain_submission_events where submission_id = $1',
            [created.id],
          );
          const moved = admin.query('update ujira.chain_submissions set state = $1 where id = $2', [
            to,
            created.id,
          ]);
          const pair = `${from} to ${to}`;
          if (isAllowed(from, to)) {
            expect(await codeOf(moved), pair).toBeUndefined();
            const after = await admin.query(
              'select id from ujira.chain_submission_events where submission_id = $1',
              [created.id],
            );
            expect(after.rowCount, pair).toBe((before.rowCount ?? 0) + 1);
          } else {
            expect(await codeOf(moved), pair).toBe('UJ004');
          }
          await admin.query('rollback to savepoint pair');
        }
      }
    } finally {
      await admin.query('rollback');
    }
  });

  it('every other move fails through the repository too', async () => {
    const created = await record();
    const backward = db
      .tenant(tenant)
      .transaction(async (tx) =>
        chainSubmissions.update(tx, created.network, created.txHash, { state: 'landed' }),
      );
    expect(await codeOf(backward)).toBe('UJ004');
  });

  it('reads back the moves in order, the first recording included', async () => {
    const created = await record();
    const events = await db.tenant(tenant).transaction(async (tx) => {
      await chainSubmissions.update(tx, created.network, created.txHash, { state: 'broadcast' });
      await chainSubmissions.update(tx, created.network, created.txHash, { state: 'unknown' });
      await chainSubmissions.update(tx, created.network, created.txHash, { state: 'landed' });
      return chainSubmissions.events(tx, created.id);
    });
    expect(events).toEqual([
      { from: null, to: 'built' },
      { from: 'built', to: 'broadcast' },
      { from: 'broadcast', to: 'unknown' },
      { from: 'unknown', to: 'landed' },
    ]);
  });

  it('writes no event for a patch that leaves the state alone', async () => {
    const created = await record();
    const events = await db.tenant(tenant).transaction(async (tx) => {
      await chainSubmissions.update(tx, created.network, created.txHash, { specCode: 46 });
      return chainSubmissions.events(tx, created.id);
    });
    expect(events).toHaveLength(1);
  });

  it('starts built, for anyone who comes around the repository', async () => {
    const created = await record();
    const inserted = admin.query(
      `insert into ujira.chain_submissions
         (principal_id, project_id, network, tx_hash, op, signer_address, sequence_or_nonce, state,
          correlation_id, created_at)
       select principal_id, project_id, network, $1, op, signer_address, 1, 'landed', 'c', now()
         from ujira.chain_submissions where id = $2`,
      [hex(32), created.id],
    );
    expect(await codeOf(inserted)).toBe('UJ004');
  });
});

describe('what may change', () => {
  it.each([
    ['the hash', `tx_hash = repeat('a', 64)`],
    ['the signer', `signer_address = 'GOTHER'`],
    ['the sequence', 'sequence_or_nonce = 99'],
  ])('refuses a change of %s, for the superuser too', async (_name, assignment) => {
    const created = await record();
    const change = admin.query(`update ujira.chain_submissions set ${assignment} where id = $1`, [
      created.id,
    ]);
    expect(await codeOf(change)).toBe('UJ002');
  });

  it('keeps the record for good, and its events', async () => {
    const created = await record();
    expect(
      await codeOf(admin.query('delete from ujira.chain_submissions where id = $1', [created.id])),
    ).toBe('UJ002');
    expect(
      await codeOf(
        admin.query('delete from ujira.chain_submission_events where submission_id = $1', [
          created.id,
        ]),
      ),
    ).toBe('UJ002');
  });

  it('gives the app no way to write an event of its own', async () => {
    const created = await record();
    const forged = db.tenant(tenant).transaction(async (tx) =>
      tx
        .insertInto('ujira.chain_submission_events')
        .values({
          principal_id: tenant.principalId,
          project_id: tenant.projectId,
          submission_id: created.id,
          to_state: 'landed',
        })
        .execute(),
    );
    expect(await codeOf(forged)).toBe('42501');
  });
});

describe('the proof that an attempt is dead', () => {
  // The adapter can prove all four, so a row holding any of them must be accepted. With
  // triggers off, because only the row's own checks are in question, and nothing is kept.
  it.each(['tombstone', 'deadline_passed', 'payout_lapsed', 'agent_removed'])(
    'admits %s',
    async (kind) => {
      await admin.query('begin');
      try {
        await admin.query('set local session_replication_role = replica');
        const inserted = admin.query(
          `insert into ujira.payout_attempts
             (principal_id, project_id, payout_id, attempt_number, chain, network,
              mandate_instance_id, total_amount, asset, scale, deadline, status, dead_proof)
           values ($1, $2, gen_random_uuid(), 1, 'stellar', 'stellar:testnet', gen_random_uuid(), 1,
                   'USDC', 7, now(), 'dead', $3)`,
          [tenant.principalId, tenant.projectId, JSON.stringify({ kind })],
        );
        expect(await codeOf(inserted)).toBeUndefined();
      } finally {
        await admin.query('rollback');
      }
    },
  );
});

describe('the network', () => {
  it('reuses the network domain, so an unknown network is refused', async () => {
    expect(await codeOf(record({ network: 'stellar:mainnet' }))).toBe('23514');
  });

  it.each([
    ['a hash that is not lower case hex', { txHash: 'ABC' }],
    ['an unknown op', { op: 'steal' }],
    ['a payout id that is not 32 bytes', { payoutId: '0x12' }],
  ])('refuses %s', async (_name, overrides) => {
    expect(await codeOf(record(overrides))).toBe('23514');
  });
});
