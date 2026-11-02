// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Receipts are permanent. A correction is a new revision, and the old one stays.
// That a receipt lists every leg of its attempt and adds up is the database's rule,
// checked at commit (UJ016). As everywhere, no method takes a tenant id.

import type { TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { amountParam, tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import { IdempotencyConflictError } from './payouts.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

// A correction that does not follow the revision it says it does, so the caller
// was working from an old receipt, or from none.
export class ReceiptRevisionError extends Error {
  readonly code = 'RECEIPT_REVISION';

  constructor(revision: number) {
    super(`revision ${String(revision)} does not follow the latest revision of this receipt`);
    this.name = 'ReceiptRevisionError';
  }
}

export interface NewReceiptLeg {
  readonly legIndex: number;
  readonly destinationAddress: string;
  readonly destinationTag?: bigint | null;
  // In the receipt's unit, so raw token units.
  readonly amount: bigint;
  readonly fee?: bigint;
  readonly chainTxHash: string;
}

export interface NewReceipt {
  readonly payoutId: string;
  readonly attemptId: string;
  // 1 for the first receipt, and one above the latest for a correction.
  readonly revision: number;
  readonly chainReceiptRef: string;
  readonly settlement: TokenAmount;
  // The sum of the legs' fees, in the settlement's unit.
  readonly fee: bigint;
  readonly legs: readonly NewReceiptLeg[];
}

export interface ReceiptLeg {
  readonly legIndex: number;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly amount: TokenAmount;
  readonly fee: TokenAmount;
  readonly chainTxHash: string;
}

export interface Receipt {
  readonly id: string;
  readonly payoutId: string;
  readonly attemptId: string;
  readonly revision: number;
  readonly chainReceiptRef: string;
  readonly settlement: TokenAmount;
  readonly fee: TokenAmount;
  readonly createdAt: Date;
}

export interface RecordedReceipt {
  readonly receipt: Receipt;
  // False when this revision had already been written with the same figures.
  readonly created: boolean;
}

const receiptColumns = [
  'id',
  'payout_id',
  'attempt_id',
  'revision',
  'chain_receipt_ref',
  'chain',
  'asset',
  'scale',
  'settlement_amount',
  'fee_amount',
  'created_at',
] as const;

function toReceipt(row: {
  id: string;
  payout_id: string;
  attempt_id: string;
  revision: number;
  chain_receipt_ref: string;
  chain: string;
  asset: string;
  scale: number;
  settlement_amount: string;
  fee_amount: string;
  created_at: Date;
}): Receipt {
  const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
  return {
    id: row.id,
    payoutId: row.payout_id,
    attemptId: row.attempt_id,
    revision: row.revision,
    chainReceiptRef: row.chain_receipt_ref,
    settlement: tokenFromRow({ amount: row.settlement_amount, ...unit }),
    fee: tokenFromRow({ amount: row.fee_amount, ...unit }),
    createdAt: row.created_at,
  };
}

export const receipts = {
  // Safe to retry: the same revision with the same figures finds the first, and
  // with different figures is refused. Refused with ReceiptRevisionError unless it
  // directly follows the latest, so a correction made from a stale copy is noticed.
  record: async (db: Tx, input: NewReceipt): Promise<RecordedReceipt> => {
    const latest = await db
      .selectFrom('ujira.receipts')
      .select((eb) => eb.fn.max<number>('revision').as('revision'))
      .where('payout_id', '=', input.payoutId)
      .executeTakeFirst();
    const current = latest?.revision ?? 0;
    if (input.revision > current + 1 || input.revision < 1) {
      throw new ReceiptRevisionError(input.revision);
    }
    const inserted = await db
      .insertInto('ujira.receipts')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        payout_id: input.payoutId,
        attempt_id: input.attemptId,
        revision: input.revision,
        chain_receipt_ref: input.chainReceiptRef,
        chain: input.settlement.chain,
        asset: input.settlement.asset,
        scale: input.settlement.scale,
        settlement_amount: amountParam(input.settlement),
        fee_amount: input.fee.toString(),
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'payout_id', 'revision']).doNothing(),
      )
      .returning(receiptColumns)
      .executeTakeFirst();
    if (inserted === undefined) {
      const first = await db
        .selectFrom('ujira.receipts')
        .select(receiptColumns)
        .where('payout_id', '=', input.payoutId)
        .where('revision', '=', input.revision)
        .executeTakeFirstOrThrow();
      if (
        first.attempt_id !== input.attemptId ||
        first.chain_receipt_ref !== input.chainReceiptRef ||
        first.settlement_amount !== amountParam(input.settlement) ||
        first.fee_amount !== input.fee.toString()
      ) {
        throw new IdempotencyConflictError();
      }
      return { receipt: toReceipt(first), created: false };
    }
    if (input.legs.length > 0) {
      await db
        .insertInto('ujira.receipt_legs')
        .values(
          input.legs.map((leg) => ({
            principal_id: CURRENT_PRINCIPAL,
            project_id: CURRENT_PROJECT,
            receipt_id: inserted.id,
            attempt_id: input.attemptId,
            leg_index: leg.legIndex,
            destination_address: leg.destinationAddress,
            destination_tag: leg.destinationTag?.toString() ?? null,
            amount: leg.amount.toString(),
            fee_amount: (leg.fee ?? 0n).toString(),
            chain: input.settlement.chain,
            asset: input.settlement.asset,
            scale: input.settlement.scale,
            chain_tx_hash: leg.chainTxHash,
          })),
        )
        .execute();
    }
    return { receipt: toReceipt(inserted), created: true };
  },

  latest: async (db: Tx, payoutId: string): Promise<Receipt | undefined> => {
    const row = await db
      .selectFrom('ujira.receipts')
      .select(receiptColumns)
      .where('payout_id', '=', payoutId)
      .orderBy('revision', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toReceipt(row);
  },

  revisions: async (db: Tx, payoutId: string): Promise<readonly Receipt[]> => {
    const rows = await db
      .selectFrom('ujira.receipts')
      .select(receiptColumns)
      .where('payout_id', '=', payoutId)
      .orderBy('revision')
      .execute();
    return rows.map(toReceipt);
  },

  legs: async (db: Tx, receiptId: string): Promise<readonly ReceiptLeg[]> => {
    const rows = await db
      .selectFrom('ujira.receipt_legs')
      .select([
        'leg_index',
        'destination_address',
        'destination_tag',
        'amount',
        'fee_amount',
        'chain',
        'asset',
        'scale',
        'chain_tx_hash',
      ])
      .where('receipt_id', '=', receiptId)
      .orderBy('leg_index')
      .execute();
    return rows.map((row) => {
      const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
      return {
        legIndex: row.leg_index,
        destinationAddress: row.destination_address,
        destinationTag: row.destination_tag === null ? null : BigInt(row.destination_tag),
        amount: tokenFromRow({ amount: row.amount, ...unit }),
        fee: tokenFromRow({ amount: row.fee_amount, ...unit }),
        chainTxHash: row.chain_tx_hash,
      };
    });
  },
};

export const receiptRepositories = { receipts } as const;
