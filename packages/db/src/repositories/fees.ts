// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fee terms, fee reconciliations, leg refunds and fee refunds. As everywhere, no method
// takes a tenant id, and the database holds every rule that matters for money. The fee
// here is the take alone, as charged on an attempt.

import { createHash } from 'node:crypto';

import type { TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import type { AuditActor } from './audit.js';
import { assertTransition, IdempotencyConflictError } from './payouts.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

const UNIQUE_VIOLATION = '23505';
const FEE_REFUND_DUE_MS = 7 * 24 * 60 * 60 * 1000;

export const FEE_REFUND_STATUS_VALUES = [
  'owed',
  'awaiting_signatures',
  'submitted',
  'settled',
  'failed',
  'not_owed',
] as const;

export type FeeRefundStatusValue = (typeof FEE_REFUND_STATUS_VALUES)[number];

export type FeeBasis = 'standard' | 'committed_volume' | 'negotiated' | 'internal_at_cost';

export class FeeTermsExistError extends Error {
  readonly code = 'FEE_TERMS_EXIST';

  constructor() {
    super('this project already has fee terms from this instant');
    this.name = 'FeeTermsExistError';
  }
}

// A fee is owed from the address that received it. Until the instance has reported that
// address there is nowhere to send a refund from, and guessing could send it from the
// wrong place.
export class FeeAddressUnknownError extends Error {
  readonly code = 'FEE_ADDRESS_UNKNOWN';

  constructor() {
    super('the fee address of this mandate instance is not known yet');
    this.name = 'FeeAddressUnknownError';
  }
}

export interface NewFeeTerms {
  readonly rateBps: number;
  readonly basis: FeeBasis;
  readonly validFrom: Date;
  // Points at the contract, and never holds its text.
  readonly contractReference: string | null;
  readonly actor: AuditActor;
}

export interface FeeTerms {
  readonly id: string;
  readonly rateBps: number;
  readonly basis: string;
  readonly validFrom: Date;
  readonly contractReference: string | null;
  readonly createdAt: Date;
}

const termsColumns = [
  'id',
  'rate_bps',
  'basis',
  'valid_from',
  'contract_reference',
  'created_at',
] as const;

export type FeeResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'waived' }
  | { readonly kind: 'invoiced'; readonly invoiceReference: string };

export interface NewFeeReconciliation {
  readonly attemptId: string;
  // Starts at 1, and goes up when a correction changes the figures.
  readonly revision: number;
  // In the attempt's unit. The outcome and the shortfall are worked out from these.
  readonly expected: bigint;
  readonly onChain: bigint;
  readonly received: bigint;
  readonly resolution?: FeeResolution;
}

export interface FeeReconciliation {
  readonly id: string;
  readonly attemptId: string;
  readonly revision: number;
  readonly expected: TokenAmount;
  readonly onChain: TokenAmount;
  readonly received: TokenAmount;
  readonly shortfall: TokenAmount;
  readonly outcome: string;
  readonly resolution: string;
  readonly invoiceReference: string | null;
  readonly createdAt: Date;
}

const reconciliationColumns = [
  'id',
  'attempt_id',
  'revision',
  'chain',
  'asset',
  'scale',
  'expected_fee_amount',
  'on_chain_fee_amount',
  'received_fee_amount',
  'shortfall_amount',
  'outcome',
  'resolution',
  'invoice_reference',
  'created_at',
] as const;

function toReconciliation(row: {
  id: string;
  attempt_id: string;
  revision: string;
  chain: string;
  asset: string;
  scale: number;
  expected_fee_amount: string;
  on_chain_fee_amount: string;
  received_fee_amount: string;
  shortfall_amount: string;
  outcome: string;
  resolution: string;
  invoice_reference: string | null;
  created_at: Date;
}): FeeReconciliation {
  const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
  return {
    id: row.id,
    attemptId: row.attempt_id,
    // Checked to a range well inside a double, so this is exact.
    revision: Number(row.revision),
    expected: tokenFromRow({ amount: row.expected_fee_amount, ...unit }),
    onChain: tokenFromRow({ amount: row.on_chain_fee_amount, ...unit }),
    received: tokenFromRow({ amount: row.received_fee_amount, ...unit }),
    shortfall: tokenFromRow({ amount: row.shortfall_amount, ...unit }),
    outcome: row.outcome,
    resolution: row.resolution,
    invoiceReference: row.invoice_reference,
    createdAt: row.created_at,
  };
}

function outcomeOf(expected: bigint, onChain: bigint, received: bigint): string {
  if (expected === onChain && onChain === received) return 'matched';
  return received < expected ? 'underpaid' : 'mismatch';
}

export const fees = {
  // The terms in force at an instant: the latest that took effect at or before it.
  termsAt: async (db: Tx, at: Date): Promise<FeeTerms | undefined> => {
    const row = await db
      .selectFrom('ujira.fee_terms')
      .select(termsColumns)
      .where('valid_from', '<=', at)
      .orderBy('valid_from', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      // Checked to be 0 to 100, so this is exact.
      rateBps: Number(row.rate_bps),
      basis: row.basis,
      validFrom: row.valid_from,
      contractReference: row.contract_reference,
      createdAt: row.created_at,
    };
  },

  // The only way terms reach the table, and it writes the audit row with them. Whoever
  // calls this must already have decided the caller may set terms.
  recordTerms: async (db: Tx, input: NewFeeTerms): Promise<{ readonly id: string }> => {
    const actorId = input.actor.kind === 'system' ? null : input.actor.id;
    try {
      const result = await sql<{ id: string }>`
        select ujira.record_fee_terms(
          ${input.rateBps}::bigint,
          ${input.basis},
          ${input.validFrom}::timestamptz,
          ${input.contractReference},
          ${input.actor.kind},
          ${actorId}::uuid
        ) as id
      `.execute(db);
      const [row] = result.rows;
      if (row === undefined) throw new Error('record_fee_terms returned nothing');
      return { id: row.id };
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new FeeTermsExistError();
      throw error;
    }
  },

  reconciliation: async (
    db: Tx,
    attemptId: string,
    revision: number,
  ): Promise<FeeReconciliation | undefined> => {
    const row = await db
      .selectFrom('ujira.fee_reconciliations')
      .select(reconciliationColumns)
      .where('attempt_id', '=', attemptId)
      .where('revision', '=', revision.toString())
      .executeTakeFirst();
    return row === undefined ? undefined : toReconciliation(row);
  },

  // One row per attempt and revision. A retry finds the first with created false, and
  // the same revision with other figures is IdempotencyConflictError. Undefined when the
  // attempt is not visible here. Refused with UJ019 unless the attempt has executed.
  recordReconciliation: async (
    db: Tx,
    input: NewFeeReconciliation,
  ): Promise<
    { readonly created: boolean; readonly reconciliation: FeeReconciliation } | undefined
  > => {
    const attempt = await db
      .selectFrom('ujira.payout_attempts')
      .select(['payout_id', 'chain', 'asset', 'scale'])
      .where('id', '=', input.attemptId)
      .executeTakeFirst();
    if (attempt === undefined) return undefined;
    const resolution = input.resolution ?? { kind: 'none' };
    const shortfall = input.expected > input.received ? input.expected - input.received : 0n;
    const outcome = outcomeOf(input.expected, input.onChain, input.received);
    const inserted = await db
      .insertInto('ujira.fee_reconciliations')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        payout_id: attempt.payout_id,
        attempt_id: input.attemptId,
        revision: input.revision,
        chain: attempt.chain,
        asset: attempt.asset,
        scale: attempt.scale,
        expected_fee_amount: input.expected.toString(),
        on_chain_fee_amount: input.onChain.toString(),
        received_fee_amount: input.received.toString(),
        shortfall_amount: shortfall.toString(),
        outcome,
        resolution: resolution.kind,
        invoice_reference: resolution.kind === 'invoiced' ? resolution.invoiceReference : null,
      })
      .onConflict((conflict) => conflict.constraint('fee_reconciliations_per_revision').doNothing())
      .returning(reconciliationColumns)
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { created: true, reconciliation: toReconciliation(inserted) };
    }
    const existing = await fees.reconciliation(db, input.attemptId, input.revision);
    if (existing === undefined) throw new IdempotencyConflictError();
    const same =
      existing.expected.amount === input.expected &&
      existing.onChain.amount === input.onChain &&
      existing.received.amount === input.received &&
      existing.resolution === resolution.kind;
    if (!same) throw new IdempotencyConflictError();
    return { created: false, reconciliation: existing };
  },
};

export interface NewLegRefund {
  readonly payoutLegId: string;
  // In the leg's unit.
  readonly amount: bigint;
  // The principal's own address.
  readonly refundToAddress: string;
  readonly txHash: Buffer;
  readonly eventIndex: bigint;
}

export interface LegRefund {
  readonly id: string;
  readonly payoutLegId: string;
  readonly attemptId: string;
  readonly amount: TokenAmount;
  readonly refundToAddress: string;
  readonly txHash: Buffer;
  readonly eventIndex: bigint;
  readonly createdAt: Date;
}

const legRefundColumns = [
  'id',
  'payout_leg_id',
  'attempt_id',
  'chain',
  'asset',
  'scale',
  'amount',
  'refund_to_address',
  'tx_hash',
  'event_index',
  'created_at',
] as const;

function toLegRefund(row: {
  id: string;
  payout_leg_id: string;
  attempt_id: string;
  chain: string;
  asset: string;
  scale: number;
  amount: string;
  refund_to_address: string;
  tx_hash: Buffer;
  event_index: string;
  created_at: Date;
}): LegRefund {
  return {
    id: row.id,
    payoutLegId: row.payout_leg_id,
    attemptId: row.attempt_id,
    amount: tokenFromRow({
      amount: row.amount,
      asset: row.asset,
      chain: row.chain,
      scale: row.scale,
    }),
    refundToAddress: row.refund_to_address,
    txHash: row.tx_hash,
    eventIndex: BigInt(row.event_index),
    createdAt: row.created_at,
  };
}

export interface FeeRefund {
  readonly id: string;
  readonly legRefundId: string;
  readonly attemptId: string;
  readonly amount: TokenAmount;
  readonly fromAddress: string | null;
  readonly toAddress: string;
  readonly status: string;
  readonly idempotencyKey: Buffer;
  readonly dueAt: Date;
  readonly txHash: Buffer | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const feeRefundColumns = [
  'id',
  'leg_refund_id',
  'attempt_id',
  'chain',
  'asset',
  'scale',
  'amount',
  'from_address',
  'to_address',
  'status',
  'idempotency_key',
  'due_at',
  'tx_hash',
  'failure_reason',
  'created_at',
  'updated_at',
] as const;

function toFeeRefund(row: {
  id: string;
  leg_refund_id: string;
  attempt_id: string;
  chain: string;
  asset: string;
  scale: number;
  amount: string;
  from_address: string | null;
  to_address: string;
  status: string;
  idempotency_key: Buffer;
  due_at: Date;
  tx_hash: Buffer | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}): FeeRefund {
  return {
    id: row.id,
    legRefundId: row.leg_refund_id,
    attemptId: row.attempt_id,
    amount: tokenFromRow({
      amount: row.amount,
      asset: row.asset,
      chain: row.chain,
      scale: row.scale,
    }),
    fromAddress: row.from_address,
    toAddress: row.to_address,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    dueAt: row.due_at,
    txHash: row.tx_hash,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function feeRefundKey(legRefundId: string): Buffer {
  return createHash('sha256').update(`ujira/fee-refund/v1${legRefundId}`, 'utf8').digest();
}

export const refunds = {
  // One row per event on the chain, so a retry or a replayed event finds the first with
  // created false, and the same event with other figures is IdempotencyConflictError.
  // Undefined when the leg is not visible here, or the event was already recorded by
  // another tenant. Refunds above the leg are refused at commit with UJ008.
  recordLegRefund: async (
    db: Tx,
    input: NewLegRefund,
  ): Promise<{ readonly created: boolean; readonly legRefund: LegRefund } | undefined> => {
    const leg = await db
      .selectFrom('ujira.payout_legs')
      .select(['payout_id', 'attempt_id', 'chain', 'asset', 'scale'])
      .where('id', '=', input.payoutLegId)
      .executeTakeFirst();
    if (leg === undefined) return undefined;
    const inserted = await db
      .insertInto('ujira.leg_refunds')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        payout_leg_id: input.payoutLegId,
        // leg_refunds_stamp writes these from the leg in any case.
        payout_id: leg.payout_id,
        attempt_id: leg.attempt_id,
        chain: leg.chain,
        asset: leg.asset,
        scale: leg.scale,
        amount: input.amount.toString(),
        refund_to_address: input.refundToAddress,
        tx_hash: input.txHash,
        event_index: input.eventIndex,
      })
      .onConflict((conflict) => conflict.constraint('leg_refunds_once').doNothing())
      .returning(legRefundColumns)
      .executeTakeFirst();
    if (inserted !== undefined) return { created: true, legRefund: toLegRefund(inserted) };
    const existing = await db
      .selectFrom('ujira.leg_refunds')
      .select(legRefundColumns)
      .where('chain', '=', leg.chain)
      .where('tx_hash', '=', input.txHash)
      .where('event_index', '=', input.eventIndex.toString())
      .executeTakeFirst();
    if (existing === undefined) return undefined;
    const found = toLegRefund(existing);
    if (found.payoutLegId !== input.payoutLegId || found.amount.amount !== input.amount) {
      throw new IdempotencyConflictError();
    }
    return { created: false, legRefund: found };
  },

  // Works out the part of the attempt's fee charged on what came back: the fee scaled by
  // refund over total, rounded down. Rounding down means the shares of any split of the
  // total can never add up to more than the fee. A share of nothing is recorded as not
  // owed, so a leg refund always shows that the question was answered.
  //
  // One row per leg refund however many calls race; the second and later get the first
  // back with created false. Undefined when the leg refund is not visible here.
  planFeeRefund: async (
    db: Tx,
    legRefundId: string,
  ): Promise<{ readonly created: boolean; readonly feeRefund: FeeRefund } | undefined> => {
    const source = await db
      .selectFrom('ujira.leg_refunds as r')
      .innerJoin('ujira.payout_attempts as a', 'a.id', 'r.attempt_id')
      .innerJoin('ujira.mandate_instances as i', 'i.id', 'a.mandate_instance_id')
      .select([
        'r.payout_id',
        'r.attempt_id',
        'r.chain',
        'r.asset',
        'r.scale',
        'r.amount',
        'r.refund_to_address',
        'r.created_at',
        'a.fee_amount',
        'a.total_amount',
        'i.fee_address',
      ])
      .where('r.id', '=', legRefundId)
      .executeTakeFirst();
    if (source === undefined) return undefined;
    const amount =
      (BigInt(source.amount) * BigInt(source.fee_amount)) / BigInt(source.total_amount);
    if (amount > 0n && source.fee_address === null) throw new FeeAddressUnknownError();
    const inserted = await db
      .insertInto('ujira.fee_refunds')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        leg_refund_id: legRefundId,
        payout_id: source.payout_id,
        attempt_id: source.attempt_id,
        chain: source.chain,
        asset: source.asset,
        scale: source.scale,
        amount: amount.toString(),
        from_address: source.fee_address,
        to_address: source.refund_to_address,
        status: amount > 0n ? 'owed' : 'not_owed',
        idempotency_key: feeRefundKey(legRefundId),
        due_at: new Date(source.created_at.getTime() + FEE_REFUND_DUE_MS),
      })
      .onConflict((conflict) => conflict.constraint('fee_refunds_one_per_leg_refund').doNothing())
      .returning(feeRefundColumns)
      .executeTakeFirst();
    if (inserted !== undefined) return { created: true, feeRefund: toFeeRefund(inserted) };
    const existing = await db
      .selectFrom('ujira.fee_refunds')
      .select(feeRefundColumns)
      .where('leg_refund_id', '=', legRefundId)
      .executeTakeFirstOrThrow();
    return { created: false, feeRefund: toFeeRefund(existing) };
  },

  feeRefund: async (db: Tx, id: string): Promise<FeeRefund | undefined> => {
    const row = await db
      .selectFrom('ujira.fee_refunds')
      .select(feeRefundColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toFeeRefund(row);
  },

  // Moves only from the status the caller saw, so a worker acting on a stale read finds
  // nothing to do. A move the machine does not list is IllegalTransitionError. Undefined
  // when the refund is not visible here or has already moved on.
  transitionFeeRefund: async (
    db: Tx,
    id: string,
    from: FeeRefundStatusValue,
    to: FeeRefundStatusValue,
    patch: { readonly txHash?: Buffer; readonly failureReason?: string } = {},
  ): Promise<FeeRefund | undefined> => {
    await assertTransition(db, 'fee_refund', from, to);
    const row = await db
      .updateTable('ujira.fee_refunds')
      .set({
        status: to,
        ...(patch.txHash === undefined ? {} : { tx_hash: patch.txHash }),
        ...(patch.failureReason === undefined ? {} : { failure_reason: patch.failureReason }),
      })
      .where('id', '=', id)
      .where('status', '=', from)
      .returning(feeRefundColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toFeeRefund(row);
  },
};

export const feeRepositories = { fees, refunds } as const;
