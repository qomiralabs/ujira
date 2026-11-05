// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Payout legs and approvals. A leg is written with its attempt, through
// payoutAttempts.create, so what can happen to one here is only that it moves on.
// That the legs of an attempt sum to its total is the database's rule, checked at
// commit (UJ005).

import type { Money, TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { fiatFromRow, tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import { assertTransition, IdempotencyConflictError } from './payouts.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export const LEG_STATUS_VALUES = [
  'planned',
  'submitted',
  'settled',
  'delivering',
  'delivered',
  'failed',
  'cancelled',
] as const;

export type LegStatusValue = (typeof LEG_STATUS_VALUES)[number];

// What a cash-out delivers: null on a leg paid straight to a wallet.
export interface LegDelivery {
  readonly receive: Money;
  readonly fxNumerator: bigint;
  readonly fxDenominator: bigint;
  readonly costBearer: string;
  readonly quoteId: string;
}

export interface PayoutLeg {
  readonly id: string;
  readonly payoutId: string;
  readonly attemptId: string;
  readonly index: number;
  readonly payoutMethodId: string;
  readonly method: string;
  readonly rail: string | null;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly amount: TokenAmount;
  readonly fee: TokenAmount;
  readonly legKey: string;
  readonly chainTxHash: string | null;
  readonly status: string;
  readonly delivery: LegDelivery | null;
}

const legColumns = [
  'id',
  'payout_id',
  'attempt_id',
  'leg_index',
  'payout_method_id',
  'method',
  'rail',
  'destination_address',
  'destination_tag',
  'amount',
  'chain',
  'asset',
  'scale',
  'fee_amount',
  'leg_key',
  'chain_tx_hash',
  'status',
  'receive_amount',
  'receive_currency',
  'receive_scale',
  'fx_numerator',
  'fx_denominator',
  'cost_bearer',
  'quote_id',
] as const;

function toLeg(row: {
  id: string;
  payout_id: string;
  attempt_id: string;
  leg_index: string;
  payout_method_id: string;
  method: string;
  rail: string | null;
  destination_address: string;
  destination_tag: string | null;
  amount: string;
  chain: string;
  asset: string;
  scale: number;
  fee_amount: string;
  leg_key: string;
  chain_tx_hash: string | null;
  status: string;
  receive_amount: string | null;
  receive_currency: string | null;
  receive_scale: number | null;
  fx_numerator: string | null;
  fx_denominator: string | null;
  cost_bearer: string | null;
  quote_id: string | null;
}): PayoutLeg {
  const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
  return {
    id: row.id,
    payoutId: row.payout_id,
    attemptId: row.attempt_id,
    // Checked to be 0 to 3, so this is exact.
    index: Number(row.leg_index),
    payoutMethodId: row.payout_method_id,
    method: row.method,
    rail: row.rail,
    destinationAddress: row.destination_address,
    destinationTag: row.destination_tag === null ? null : BigInt(row.destination_tag),
    amount: tokenFromRow({ amount: row.amount, ...unit }),
    fee: tokenFromRow({ amount: row.fee_amount, ...unit }),
    legKey: row.leg_key,
    chainTxHash: row.chain_tx_hash,
    status: row.status,
    // All or none, by the table's own check.
    delivery:
      row.receive_amount === null ||
      row.receive_currency === null ||
      row.receive_scale === null ||
      row.fx_numerator === null ||
      row.fx_denominator === null ||
      row.cost_bearer === null ||
      row.quote_id === null
        ? null
        : {
            receive: fiatFromRow({
              amount: row.receive_amount,
              currency: row.receive_currency,
              scale: row.receive_scale,
            }),
            fxNumerator: BigInt(row.fx_numerator),
            fxDenominator: BigInt(row.fx_denominator),
            costBearer: row.cost_bearer,
            quoteId: row.quote_id,
          },
  };
}

export const payoutLegs = {
  forAttempt: async (db: Tx, attemptId: string): Promise<readonly PayoutLeg[]> => {
    const rows = await db
      .selectFrom('ujira.payout_legs')
      .select(legColumns)
      .where('attempt_id', '=', attemptId)
      .orderBy('leg_index')
      .execute();
    return rows.map(toLeg);
  },

  // Compare and set: undefined when the leg is not at `from`.
  transition: async (
    db: Tx,
    id: string,
    move: {
      readonly from: LegStatusValue;
      readonly to: LegStatusValue;
      readonly chainTxHash?: string;
    },
  ): Promise<PayoutLeg | undefined> => {
    await assertTransition(db, 'payout_leg', move.from, move.to);
    const row = await db
      .updateTable('ujira.payout_legs')
      .set({
        status: move.to,
        ...(move.chainTxHash === undefined ? {} : { chain_tx_hash: move.chainTxHash }),
      })
      .where('id', '=', id)
      .where('status', '=', move.from)
      .returning(legColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toLeg(row);
  },
};

export type ApprovalDecision = 'approved' | 'rejected';

export interface NewApproval {
  readonly attemptId: string;
  readonly approver: string;
  readonly decision: ApprovalDecision;
  // SHA-256 of what was signed, 32 bytes.
  readonly signedMessageHash: Buffer;
  readonly signature: Buffer;
}

export interface Approval {
  readonly id: string;
  readonly attemptId: string;
  readonly approver: string;
  readonly decision: string;
  readonly signedMessageHash: Buffer;
  readonly signature: Buffer;
  readonly createdAt: Date;
}

export interface RecordedApproval {
  readonly approval: Approval;
  readonly created: boolean;
}

const approvalColumns = [
  'id',
  'attempt_id',
  'approver',
  'decision',
  'signed_message_hash',
  'signature',
  'created_at',
] as const;

function toApproval(row: {
  id: string;
  attempt_id: string;
  approver: string;
  decision: string;
  signed_message_hash: Buffer;
  signature: Buffer;
  created_at: Date;
}): Approval {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    approver: row.approver,
    decision: row.decision,
    signedMessageHash: row.signed_message_hash,
    signature: row.signature,
    createdAt: row.created_at,
  };
}

export const approvals = {
  // An approver decides once per attempt. The same decision again finds the first,
  // so a retry is safe, and a different one is refused: an approver cannot take a
  // signature back by writing another row.
  record: async (db: Tx, input: NewApproval): Promise<RecordedApproval> => {
    const inserted = await db
      .insertInto('ujira.approvals')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        attempt_id: input.attemptId,
        approver: input.approver,
        decision: input.decision,
        signed_message_hash: input.signedMessageHash,
        signature: input.signature,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'attempt_id', 'approver']).doNothing(),
      )
      .returning(approvalColumns)
      .executeTakeFirst();
    if (inserted !== undefined) return { approval: toApproval(inserted), created: true };
    const first = await db
      .selectFrom('ujira.approvals')
      .select(approvalColumns)
      .where('attempt_id', '=', input.attemptId)
      .where('approver', '=', input.approver)
      .executeTakeFirstOrThrow();
    if (
      first.decision !== input.decision ||
      !first.signed_message_hash.equals(input.signedMessageHash) ||
      !first.signature.equals(input.signature)
    ) {
      throw new IdempotencyConflictError();
    }
    return { approval: toApproval(first), created: false };
  },

  forAttempt: async (db: Tx, attemptId: string): Promise<readonly Approval[]> => {
    const rows = await db
      .selectFrom('ujira.approvals')
      .select(approvalColumns)
      .where('attempt_id', '=', attemptId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toApproval);
  },
};

export const legRepositories = { payoutLegs, approvals } as const;
