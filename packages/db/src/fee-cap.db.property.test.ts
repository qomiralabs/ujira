// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The database must agree with the contract on every fee. The contract computes its cap
// without ever forming total * bps, and so does the check. This holds that check to
// exact big-integer arithmetic across the whole amount range, which shares nothing with
// either of them. The take is all a fee is, so there is no other component to allow for.

import { randomUUID } from 'node:crypto';

import { I128_MAX } from '@ujira/core';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

const RUNS_PER_BAND = 2000;
const INSERT_RUNS_PER_BAND = 200;

const BANDS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 9],
  [10, 49],
  [50, 99],
  [100, 100],
];

let database: TestDatabase;
let client: pg.Client;
let withinCap: string;

function reference(total: bigint, bps: number): bigint {
  return (total * BigInt(bps)) / 10_000n;
}

// A random total over the whole range rarely lands anywhere interesting, so this leans
// on small totals and on the edges of the 10000 the cap divides by.
function totals(max: bigint): fc.Arbitrary<bigint> {
  return fc.oneof(
    fc.bigInt({ min: 1n, max }),
    fc.bigInt({ min: 1n, max: 1_000_000n }),
    fc
      .tuple(fc.bigInt({ min: 1n, max: max / 10_000n }), fc.bigInt({ min: -1n, max: 1n }))
      .map(([multiple, offset]) => multiple * 10_000n + offset),
  );
}

async function holds(total: bigint, fee: bigint, bps: number): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `select ${withinCap} as ok
       from (select $1::numeric as total_amount, $2::numeric as fee_amount, $3::bigint as fee_bps_applied) as row`,
    [total.toString(), fee.toString(), bps],
  );
  return result.rows[0]?.ok === true;
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  // The check itself as the database holds it, so this cannot pass against a copy of it
  // that has drifted.
  const found = await client.query<{ definition: string }>(
    `select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'payout_attempts_fee_within_cap'`,
  );
  const definition = found.rows[0]?.definition ?? '';
  const match = /^CHECK (\(.*\))(?: NOT VALID)?$/su.exec(definition);
  if (match?.[1] === undefined) throw new Error(`unexpected check: ${definition}`);
  withinCap = match[1];
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

describe('the fee cap against a big-integer reference', () => {
  it.each(BANDS)(
    `the check matches the reference for rates %i to %i, over ${String(RUNS_PER_BAND)} runs`,
    async (low, high) => {
      await fc.assert(
        fc.asyncProperty(
          totals(I128_MAX),
          fc.integer({ min: low, max: high }),
          async (total, bps) => {
            const cap = reference(total, bps);
            expect(await holds(total, cap, bps)).toBe(true);
            expect(await holds(total, cap + 1n, bps)).toBe(false);
          },
        ),
        { numRuns: RUNS_PER_BAND },
      );
    },
    600_000,
  );

  it('matches at the edges of the range for every rate from 0 to 100', async () => {
    const edges = [1n, 99n, 100n, 9_999n, 10_000n, 10_001n, I128_MAX - 1n, I128_MAX];
    for (let bps = 0; bps <= 100; bps += 1) {
      for (const total of edges) {
        const cap = reference(total, bps);
        expect(await holds(total, cap, bps), `${total.toString()} at ${String(bps)}`).toBe(true);
        expect(await holds(total, cap + 1n, bps), `${total.toString()} at ${String(bps)}`).toBe(
          false,
        );
      }
    }
  }, 300_000);

  describe('on the table itself', () => {
    let tenant: { principal_id: string; project_id: string };

    // Triggers off, so the row's own checks are all that can answer, and nothing is kept.
    async function insert(total: bigint, fee: bigint, bps: number): Promise<string | undefined> {
      await client.query('begin');
      try {
        await client.query('set local session_replication_role = replica');
        await client.query(
          `insert into ujira.payout_attempts
             (principal_id, project_id, payout_id, attempt_number, chain, network,
              mandate_instance_id, total_amount, asset, scale, deadline, fee_amount,
              fee_bps_applied, fee_terms_id, charged_amount)
           values ($1, $2, $3, 1, 'stellar', 'stellar:testnet', $4, $5::numeric, 'USDC', 7, now(),
                   $6::numeric, $7, $8, $9::numeric)`,
          [
            tenant.principal_id,
            tenant.project_id,
            randomUUID(),
            randomUUID(),
            total.toString(),
            fee.toString(),
            bps,
            randomUUID(),
            (total + fee).toString(),
          ],
        );
        return undefined;
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? 'refused for another reason';
      } finally {
        await client.query('rollback');
      }
    }

    beforeAll(() => {
      tenant = { principal_id: randomUUID(), project_id: randomUUID() };
    });

    // Small enough that the charge at any rate here still fits the amount domain, so
    // the only thing that can refuse the row is the cap.
    const MOST_THAT_LEAVES_ROOM = (I128_MAX / 102n) * 100n;

    it.each(BANDS)(
      'fee_amount equal to the take passes at the cap and one minor unit above is refused, rates %i to %i',
      async (low, high) => {
        await fc.assert(
          fc.asyncProperty(
            totals(MOST_THAT_LEAVES_ROOM),
            fc.integer({ min: low, max: high }),
            async (total, bps) => {
              const cap = reference(total, bps);
              expect(await insert(total, cap, bps)).toBeUndefined();
              expect(await insert(total, cap + 1n, bps)).toBe('payout_attempts_fee_within_cap');
            },
          ),
          { numRuns: INSERT_RUNS_PER_BAND },
        );
      },
      600_000,
    );
  });
});
