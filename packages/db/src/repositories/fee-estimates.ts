// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The estimated network cost of each kind of submission. These rows aggregate
// over every tenant and name none, so they are read inside db.unscoped() and
// sit outside the cross-tenant matrix, as the other ops tables do.
//
// The app role can read them. Writing needs a connection as ujira_ops, and a
// refresh writes every row inside one transaction, so a reader sees either all
// of the old rows or all of the new ones.

import type { Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;

/** The submissions priced here. The table's check holds the same closed list. */
export const FEE_ESTIMATE_OPS = Object.freeze([
  'request',
  'request_batch',
  'execute',
  'execute_batch',
  'approve',
  'reject',
  'cancel',
  'cancel_batch',
] as const);
export type FeeEstimateOp = (typeof FEE_ESTIMATE_OPS)[number];

export interface FeeEstimate {
  readonly network: string;
  readonly op: FeeEstimateOp;
  readonly legCount: number;
  readonly p95ResourceFeeStroops: bigint;
  readonly p95RentStroops: bigint;
  readonly p95InclusionFeeStroops: bigint;
  readonly sampleCount: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly computedAt: Date;
}

interface Row {
  network: string;
  op: string;
  leg_count: string;
  p95_resource_fee_stroops: string;
  p95_rent_stroops: string;
  p95_inclusion_fee_stroops: string;
  sample_count: string;
  window_start: Date;
  window_end: Date;
  computed_at: Date;
}

function fromRow(row: Row): FeeEstimate {
  return {
    network: row.network,
    // The table's check admits only the closed list.
    op: row.op as FeeEstimateOp,
    // int8 comes back from pg as text. These two are small counts, the checks
    // keep them small, and the fees stay bigints from here on.
    legCount: Number(row.leg_count),
    p95ResourceFeeStroops: BigInt(row.p95_resource_fee_stroops),
    p95RentStroops: BigInt(row.p95_rent_stroops),
    p95InclusionFeeStroops: BigInt(row.p95_inclusion_fee_stroops),
    sampleCount: Number(row.sample_count),
    windowStart: row.window_start,
    windowEnd: row.window_end,
    computedAt: row.computed_at,
  };
}

export const feeEstimates = {
  // The current estimate for one combination, or undefined when there is none.
  get: async (
    db: Tx,
    key: { readonly network: string; readonly op: FeeEstimateOp; readonly legCount: number },
  ): Promise<FeeEstimate | undefined> => {
    const row = await db
      .selectFrom('ops.fee_estimates')
      .selectAll()
      .where('network', '=', key.network)
      .where('op', '=', key.op)
      .where('leg_count', '=', String(key.legCount))
      .executeTakeFirst();
    return row === undefined ? undefined : fromRow(row);
  },

  // Every current estimate, in key order.
  list: async (db: Tx): Promise<FeeEstimate[]> => {
    const rows = await db
      .selectFrom('ops.fee_estimates')
      .selectAll()
      .orderBy('network')
      .orderBy('op')
      .orderBy('leg_count')
      .execute();
    return rows.map(fromRow);
  },

  // Writes the rows of one refresh. A combination left out keeps its previous
  // row, which is how sparse data holds on to the last good estimate.
  upsertAll: async (db: Tx, rows: readonly FeeEstimate[]): Promise<void> => {
    if (rows.length === 0) return;
    await db
      .insertInto('ops.fee_estimates')
      .values(
        rows.map((row) => ({
          network: row.network,
          op: row.op,
          leg_count: row.legCount,
          p95_resource_fee_stroops: row.p95ResourceFeeStroops.toString(),
          p95_rent_stroops: row.p95RentStroops.toString(),
          p95_inclusion_fee_stroops: row.p95InclusionFeeStroops.toString(),
          sample_count: row.sampleCount,
          window_start: row.windowStart,
          window_end: row.windowEnd,
          computed_at: row.computedAt,
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(['network', 'op', 'leg_count']).doUpdateSet((eb) => ({
          p95_resource_fee_stroops: eb.ref('excluded.p95_resource_fee_stroops'),
          p95_rent_stroops: eb.ref('excluded.p95_rent_stroops'),
          p95_inclusion_fee_stroops: eb.ref('excluded.p95_inclusion_fee_stroops'),
          sample_count: eb.ref('excluded.sample_count'),
          window_start: eb.ref('excluded.window_start'),
          window_end: eb.ref('excluded.window_end'),
          computed_at: eb.ref('excluded.computed_at'),
        })),
      )
      .execute();
  },
};
