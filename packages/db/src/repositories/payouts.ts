// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Payouts, batches, attempts, funding holds and project payout minimums. As
// everywhere, no method takes a tenant id.
//
// The database holds every rule that matters for money: the unique keys make a
// retry find the first create, the partial index allows one live attempt, and the
// triggers refuse a status change the machine does not list. The checks here turn
// those refusals into errors a caller can act on, and never replace them.

import { createHash } from 'node:crypto';

import type { Money, TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { amountParam, fiatFromRow, tokenFromRow } from '../money-mapper.js';
import {
  AmountBelowMinimumError,
  checkMinimum,
  MinimumNotComparableError,
  type MinimumAmount,
  type PayoutMinimumContext,
  type PayoutMinimumMethod,
} from '../payout-minimum.js';
import type { Schema } from '../schema.generated.js';
import { audit, type AuditActor } from './audit.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export const PAYOUT_STATUS_VALUES = [
  'received',
  'routed',
  'submitting',
  'pending_approval',
  'approved',
  'settling',
  'delivering',
  'partly_paid',
  'paid',
  'needs_attention',
  'blocked',
  'rejected',
  'cancelled',
  'failed',
] as const;

export type PayoutStatusValue = (typeof PAYOUT_STATUS_VALUES)[number];

export const ATTEMPT_STATUS_VALUES = [
  'created',
  'requested',
  'pending_approval',
  'approved',
  'executing',
  'settled',
  'final',
  'dead',
] as const;

export type AttemptStatusValue = (typeof ATTEMPT_STATUS_VALUES)[number];

export type PayoutStatusReason =
  'awaiting_funding' | 'funding_hold_expired' | 'network_unavailable';

export type CashoutCostBearer = 'recipient' | 'principal';

// The same key came back with a different body. Answering with the first payout
// would tell the caller something was done that they did not ask for.
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('this idempotency key was used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';

  constructor(machine: string, from: string, to: string) {
    super(`${machine} cannot move from ${from} to ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class LiveAttemptError extends Error {
  readonly code = 'LIVE_ATTEMPT_EXISTS';

  constructor() {
    super('this payout has a live attempt, which must be proven dead before another');
    this.name = 'LiveAttemptError';
  }
}

// An attempt with nothing to pay can never finish, and would hold the payout's one
// live slot until someone proved it dead.
export class AttemptWithoutLegsError extends Error {
  readonly code = 'ATTEMPT_WITHOUT_LEGS';

  constructor() {
    super('an attempt needs at least one leg');
    this.name = 'AttemptWithoutLegsError';
  }
}

// Recipient mode asks in a token and principal mode in a local currency, so an
// amount in the other form means the caller has the project's setting wrong.
export class RequestedAmountModeError extends Error {
  readonly code = 'REQUESTED_AMOUNT_MODE';

  constructor(bearer: CashoutCostBearer) {
    super(`a project whose cash-out bearer is ${bearer} cannot ask in this form`);
    this.name = 'RequestedAmountModeError';
  }
}

export interface NewPayout {
  readonly idempotencyKey: string;
  readonly recipientId: string;
  readonly mandateId: string;
  readonly method: PayoutMinimumMethod;
  readonly requested: Money | TokenAmount;
  readonly minimum?: PayoutMinimumContext;
}

export interface Payout {
  readonly id: string;
  readonly batchId: string | null;
  readonly recipientId: string;
  readonly mandateId: string;
  readonly method: string;
  readonly cashoutCostBearer: string;
  readonly requested: Money | TokenAmount;
  readonly total: TokenAmount | null;
  readonly status: string;
  readonly publicStatus: string;
  readonly statusReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatedPayout {
  readonly payout: Payout;
  // False when the key had already been used by an identical request.
  readonly created: boolean;
}

const payoutColumns = [
  'id',
  'batch_id',
  'recipient_id',
  'mandate_id',
  'method',
  'cashout_cost_bearer',
  'requested_amount',
  'requested_asset',
  'requested_chain',
  'requested_token_scale',
  'requested_currency',
  'requested_currency_scale',
  'total_amount',
  'total_asset',
  'total_chain',
  'total_scale',
  'status',
  'public_status',
  'status_reason',
  'request_hash',
  'created_at',
  'updated_at',
] as const;

interface PayoutRow {
  readonly id: string;
  readonly batch_id: string | null;
  readonly recipient_id: string;
  readonly mandate_id: string;
  readonly method: string;
  readonly cashout_cost_bearer: string;
  readonly requested_amount: string;
  readonly requested_asset: string | null;
  readonly requested_chain: string | null;
  readonly requested_token_scale: number | null;
  readonly requested_currency: string | null;
  readonly requested_currency_scale: number | null;
  readonly total_amount: string | null;
  readonly total_asset: string | null;
  readonly total_chain: string | null;
  readonly total_scale: number | null;
  readonly status: string;
  readonly public_status: string;
  readonly status_reason: string | null;
  readonly request_hash: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function requestedFromRow(row: PayoutRow): Money | TokenAmount {
  if (
    row.requested_asset !== null &&
    row.requested_chain !== null &&
    row.requested_token_scale !== null
  ) {
    return tokenFromRow({
      amount: row.requested_amount,
      asset: row.requested_asset,
      chain: row.requested_chain,
      scale: row.requested_token_scale,
    });
  }
  if (row.requested_currency === null || row.requested_currency_scale === null) {
    throw new Error('a payout row has neither requested unit');
  }
  return fiatFromRow({
    amount: row.requested_amount,
    currency: row.requested_currency,
    scale: row.requested_currency_scale,
  });
}

function totalFromRow(row: PayoutRow): TokenAmount | null {
  if (
    row.total_amount === null ||
    row.total_asset === null ||
    row.total_chain === null ||
    row.total_scale === null
  ) {
    return null;
  }
  return tokenFromRow({
    amount: row.total_amount,
    asset: row.total_asset,
    chain: row.total_chain,
    scale: row.total_scale,
  });
}

function toPayout(row: PayoutRow): Payout {
  return {
    id: row.id,
    batchId: row.batch_id,
    recipientId: row.recipient_id,
    mandateId: row.mandate_id,
    method: row.method,
    cashoutCostBearer: row.cashout_cost_bearer,
    requested: requestedFromRow(row),
    total: totalFromRow(row),
    status: row.status,
    publicStatus: row.public_status,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Length prefixed, so no two different requests can read the same.
function payoutRequestHash(input: NewPayout, batchId: string | null): Buffer {
  const unit =
    input.requested.kind === 'token'
      ? [input.requested.asset, input.requested.chain]
      : [input.requested.currency];
  const fields = [
    input.recipientId,
    input.mandateId,
    input.method,
    batchId ?? '',
    input.requested.kind,
    input.requested.amount.toString(),
    String(input.requested.scale),
    ...unit,
  ];
  const hash = createHash('sha256');
  for (const field of fields) hash.update(`${String(field.length)}:${field}`);
  return hash.digest();
}

function minimumFromRequested(requested: Money | TokenAmount): MinimumAmount {
  return {
    amount: requested.amount,
    currency: requested.kind === 'token' ? requested.asset : requested.currency,
    scale: requested.scale,
  };
}

// What a create needs from the project. A batch reads it once.
interface ProjectPolicy {
  readonly bearer: CashoutCostBearer;
  readonly minimums: ReadonlyMap<string, readonly MinimumAmount[]>;
}

async function projectPolicy(db: Tx): Promise<ProjectPolicy> {
  const project = await db
    .selectFrom('ujira.projects')
    .select('cashout_cost_bearer')
    .where('id', '=', CURRENT_PROJECT)
    .executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom('ujira.project_payout_minimums')
    .select(['method', 'currency', 'scale', 'min_amount'])
    .execute();
  const minimums = new Map<string, MinimumAmount[]>();
  for (const row of rows) {
    const forMethod = minimums.get(row.method) ?? [];
    forMethod.push({ amount: BigInt(row.min_amount), currency: row.currency, scale: row.scale });
    minimums.set(row.method, forMethod);
  }
  return { bearer: project.cashout_cost_bearer as CashoutCostBearer, minimums };
}

async function existingPayout(db: Tx, idempotencyKey: string): Promise<PayoutRow | undefined> {
  return db
    .selectFrom('ujira.payouts')
    .select(payoutColumns)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
}

function replayed(row: PayoutRow, hash: Buffer): CreatedPayout {
  if (!row.request_hash.equals(hash)) throw new IdempotencyConflictError();
  return { payout: toPayout(row), created: false };
}

async function createPayout(
  db: Tx,
  input: NewPayout,
  batchId: string | null,
  policy: ProjectPolicy,
): Promise<CreatedPayout> {
  const hash = payoutRequestHash(input, batchId);
  // First, so a retry gets its payout even if the project's minimum has since
  // risen above it.
  const first = await existingPayout(db, input.idempotencyKey);
  if (first !== undefined) return replayed(first, hash);

  const expected = policy.bearer === 'recipient' ? 'token' : 'fiat';
  if (input.requested.kind !== expected) throw new RequestedAmountModeError(policy.bearer);
  checkMinimum(
    input.method,
    minimumFromRequested(input.requested),
    policy.minimums.get(input.method) ?? [],
    input.minimum ?? {},
  );

  const inserted = await db
    .insertInto('ujira.payouts')
    .values({
      principal_id: CURRENT_PRINCIPAL,
      project_id: CURRENT_PROJECT,
      batch_id: batchId,
      idempotency_key: input.idempotencyKey,
      request_hash: hash,
      recipient_id: input.recipientId,
      mandate_id: input.mandateId,
      method: input.method,
      cashout_cost_bearer: policy.bearer,
      requested_amount: amountParam(input.requested),
      requested_asset: input.requested.kind === 'token' ? input.requested.asset : null,
      requested_chain: input.requested.kind === 'token' ? input.requested.chain : null,
      requested_token_scale: input.requested.kind === 'token' ? input.requested.scale : null,
      requested_currency: input.requested.kind === 'fiat' ? input.requested.currency : null,
      requested_currency_scale: input.requested.kind === 'fiat' ? input.requested.scale : null,
    })
    .onConflict((conflict) =>
      conflict.columns(['principal_id', 'project_id', 'idempotency_key']).doNothing(),
    )
    .returning(payoutColumns)
    .executeTakeFirst();
  if (inserted !== undefined) return { payout: toPayout(inserted), created: true };

  // A concurrent create won the key and has committed, since the insert waits on
  // it, so this statement's snapshot can see it.
  const winner = await existingPayout(db, input.idempotencyKey);
  if (winner === undefined) throw new Error('the idempotency key conflicted with no visible row');
  return replayed(winner, hash);
}

export async function assertTransition(
  db: Tx,
  machine: string,
  from: string,
  to: string,
): Promise<void> {
  const allowed = await db
    .selectFrom('ujira.status_transitions')
    .select('machine')
    .where('machine', '=', machine)
    .where('from_status', '=', from)
    .where('to_status', '=', to)
    .executeTakeFirst();
  if (allowed === undefined) throw new IllegalTransitionError(machine, from, to);
}

export const payouts = {
  // One payout per key however many creates race. The second and later get the
  // first back with created false. Refused below the minimum with
  // AmountBelowMinimumError, before anything is written.
  create: async (db: Tx, input: NewPayout): Promise<CreatedPayout> =>
    createPayout(db, input, null, await projectPolicy(db)),

  get: async (db: Tx, id: string): Promise<Payout | undefined> => {
    const row = await db
      .selectFrom('ujira.payouts')
      .select(payoutColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPayout(row);
  },

  list: async (db: Tx, page: PageRequest): Promise<Page<Payout>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.payouts')
      .select(payoutColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toPayout), limit, (payout) => payout.id);
  },

  // Compare and set: undefined when the payout is not at `from`, so of two workers
  // racing the same move one matches nothing. A move the machine does not list is
  // refused here, and by the trigger for anyone who comes around this method.
  transition: async (
    db: Tx,
    id: string,
    move: {
      readonly from: PayoutStatusValue;
      readonly to: PayoutStatusValue;
      readonly statusReason?: PayoutStatusReason | null;
    },
  ): Promise<Payout | undefined> => {
    await assertTransition(db, 'payout', move.from, move.to);
    const row = await db
      .updateTable('ujira.payouts')
      .set({ status: move.to, status_reason: move.statusReason ?? null })
      .where('id', '=', id)
      .where('status', '=', move.from)
      .returning(payoutColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toPayout(row);
  },
};

export interface PayoutBatch {
  readonly id: string;
  readonly createdAt: Date;
}

export type BatchItemResult =
  | { readonly key: string; readonly outcome: 'created' | 'existing'; readonly payout: Payout }
  | { readonly key: string; readonly outcome: 'refused'; readonly error: Error };

export interface CreatedBatch {
  readonly batch: PayoutBatch;
  readonly created: boolean;
  readonly items: readonly BatchItemResult[];
}

function isItemRefusal(error: unknown): error is Error {
  return (
    error instanceof AmountBelowMinimumError ||
    error instanceof MinimumNotComparableError ||
    error instanceof IdempotencyConflictError ||
    error instanceof RequestedAmountModeError
  );
}

function batchRequestHash(items: readonly NewPayout[]): Buffer {
  const hash = createHash('sha256');
  for (const item of items) {
    hash.update(`${String(item.idempotencyKey.length)}:${item.idempotencyKey}`);
    hash.update(payoutRequestHash(item, null));
  }
  return hash.digest();
}

export const payoutBatches = {
  // Items are refused one by one: one below its minimum, or reusing a key for
  // something else, leaves the others created. Anything else, such as naming a
  // recipient that does not exist, fails the whole batch and rolls it back.
  create: async (
    db: Tx,
    input: { readonly idempotencyKey: string; readonly items: readonly NewPayout[] },
  ): Promise<CreatedBatch> => {
    const hash = batchRequestHash(input.items);
    const inserted = await db
      .insertInto('ujira.payout_batches')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        idempotency_key: input.idempotencyKey,
        request_hash: hash,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'idempotency_key']).doNothing(),
      )
      .returning(['id', 'created_at'])
      .executeTakeFirst();
    let row = inserted;
    if (row === undefined) {
      const existing = await db
        .selectFrom('ujira.payout_batches')
        .select(['id', 'created_at', 'request_hash'])
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirstOrThrow();
      if (!existing.request_hash.equals(hash)) throw new IdempotencyConflictError();
      row = existing;
    }
    const policy = await projectPolicy(db);
    const items: BatchItemResult[] = [];
    for (const item of input.items) {
      try {
        const result = await createPayout(db, item, row.id, policy);
        items.push({
          key: item.idempotencyKey,
          outcome: result.created ? 'created' : 'existing',
          payout: result.payout,
        });
      } catch (error) {
        // Only refusals made before any write. A database error aborts the
        // transaction, so it has to go up.
        if (!isItemRefusal(error)) throw error;
        items.push({ key: item.idempotencyKey, outcome: 'refused', error });
      }
    }
    return {
      batch: { id: row.id, createdAt: row.created_at },
      created: inserted !== undefined,
      items,
    };
  },

  get: async (db: Tx, id: string): Promise<PayoutBatch | undefined> => {
    const row = await db
      .selectFrom('ujira.payout_batches')
      .select(['id', 'created_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : { id: row.id, createdAt: row.created_at };
  },
};

// A network as the chain adapter names it, such as `stellar:testnet`. The chain is
// only part of it, and two networks can share one.
export type NetworkId = string;

export interface NewPayoutLeg {
  readonly payoutMethodId: string;
  readonly method: PayoutMinimumMethod;
  readonly destinationAddress: string;
  readonly destinationTag?: bigint | null;
  // In the attempt's unit, so raw token units.
  readonly amount: bigint;
  // What the rail charges on this leg, in the same unit.
  readonly fee?: bigint;
}

export interface NewPayoutAttempt {
  readonly payoutId: string;
  readonly mandateInstanceId: string;
  // Must be on the total's chain, or the database refuses it.
  readonly network: NetworkId;
  readonly total: TokenAmount;
  // The take rate, paid on chain on top of the total. Charged is worked out from it.
  // None when left out. Above zero it must name the terms it came from.
  readonly fee?: {
    readonly amount: bigint;
    readonly bps: number;
    readonly termsId: string | null;
  };
  readonly deadline: Date;
  readonly onChainPayoutId?: string | null;
  // In leg order. They must sum to the total, or the commit is refused (UJ005).
  readonly legs: readonly NewPayoutLeg[];
}

export interface PayoutAttempt {
  readonly id: string;
  readonly payoutId: string;
  readonly attemptNumber: number;
  readonly network: NetworkId;
  readonly mandateInstanceId: string;
  readonly total: TokenAmount;
  readonly fee: TokenAmount;
  readonly feeBps: number;
  readonly feeTermsId: string | null;
  // Total plus fee, which is what leaves the mandate.
  readonly charged: TokenAmount;
  readonly onChainPayoutId: string | null;
  readonly deadline: Date;
  readonly deadProof: unknown;
  readonly status: string;
  readonly createdAt: Date;
}

const attemptColumns = [
  'id',
  'payout_id',
  'attempt_number',
  'chain',
  'network',
  'mandate_instance_id',
  'total_amount',
  'fee_amount',
  'fee_bps_applied',
  'fee_terms_id',
  'charged_amount',
  'asset',
  'scale',
  'on_chain_payout_id',
  'deadline',
  'dead_proof',
  'status',
  'created_at',
] as const;

function toAttempt(row: {
  id: string;
  payout_id: string;
  attempt_number: string;
  chain: string;
  network: string;
  mandate_instance_id: string;
  total_amount: string;
  fee_amount: string;
  fee_bps_applied: string;
  fee_terms_id: string | null;
  charged_amount: string | null;
  asset: string;
  scale: number;
  on_chain_payout_id: string | null;
  deadline: Date;
  dead_proof: unknown;
  status: string;
  created_at: Date;
}): PayoutAttempt {
  const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
  return {
    id: row.id,
    payoutId: row.payout_id,
    // The column is bounded well below 2^53, so this is exact.
    attemptNumber: Number(row.attempt_number),
    network: row.network,
    mandateInstanceId: row.mandate_instance_id,
    total: tokenFromRow({ amount: row.total_amount, ...unit }),
    fee: tokenFromRow({ amount: row.fee_amount, ...unit }),
    // Checked to be 0 to 100, so this is exact.
    feeBps: Number(row.fee_bps_applied),
    feeTermsId: row.fee_terms_id,
    // Null only on a row from before this column, which has no fee either.
    charged: tokenFromRow({ amount: row.charged_amount ?? row.total_amount, ...unit }),
    onChainPayoutId: row.on_chain_payout_id,
    deadline: row.deadline,
    deadProof: row.dead_proof,
    status: row.status,
    createdAt: row.created_at,
  };
}

// A proof holds ledger numbers as bigints, which JSON cannot carry.
function proofJson(proof: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(proof, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

export const payoutAttempts = {
  // Refused with LiveAttemptError unless every earlier attempt of the payout is
  // dead. Of two creates racing, the second waits for the first and then finds it.
  create: async (db: Tx, input: NewPayoutAttempt): Promise<PayoutAttempt> => {
    if (input.legs.length === 0) throw new AttemptWithoutLegsError();
    const row = await db
      .insertInto('ujira.payout_attempts')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        payout_id: input.payoutId,
        attempt_number: sql<string>`(
          select coalesce(max(a.attempt_number), 0) + 1
            from ujira.payout_attempts as a
           where a.payout_id = ${input.payoutId}
        )`,
        chain: input.total.chain,
        network: input.network,
        mandate_instance_id: input.mandateInstanceId,
        total_amount: amountParam(input.total),
        fee_amount: (input.fee?.amount ?? 0n).toString(),
        fee_bps_applied: input.fee?.bps ?? 0,
        fee_terms_id: input.fee?.termsId ?? null,
        charged_amount: (input.total.amount + (input.fee?.amount ?? 0n)).toString(),
        asset: input.total.asset,
        scale: input.total.scale,
        on_chain_payout_id: input.onChainPayoutId ?? null,
        deadline: input.deadline,
      })
      .onConflict((conflict) =>
        // A literal, because Postgres can only match a partial index to a
        // predicate it can read, and a bound parameter is not one.
        conflict
          .columns(['principal_id', 'project_id', 'payout_id'])
          .where(sql<boolean>`status <> 'dead'`)
          .doNothing(),
      )
      .returning(attemptColumns)
      .executeTakeFirst();
    if (row === undefined) throw new LiveAttemptError();
    await db
      .insertInto('ujira.payout_legs')
      .values(
        input.legs.map((leg, index) => ({
          principal_id: CURRENT_PRINCIPAL,
          project_id: CURRENT_PROJECT,
          payout_id: input.payoutId,
          attempt_id: row.id,
          leg_index: index,
          payout_method_id: leg.payoutMethodId,
          method: leg.method,
          destination_address: leg.destinationAddress,
          destination_tag: leg.destinationTag?.toString() ?? null,
          amount: leg.amount.toString(),
          chain: input.total.chain,
          asset: input.total.asset,
          scale: input.total.scale,
          fee_amount: (leg.fee ?? 0n).toString(),
        })),
      )
      .execute();
    return toAttempt(row);
  },

  get: async (db: Tx, id: string): Promise<PayoutAttempt | undefined> => {
    const row = await db
      .selectFrom('ujira.payout_attempts')
      .select(attemptColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAttempt(row);
  },

  forPayout: async (db: Tx, payoutId: string): Promise<readonly PayoutAttempt[]> => {
    const rows = await db
      .selectFrom('ujira.payout_attempts')
      .select(attemptColumns)
      .where('payout_id', '=', payoutId)
      .orderBy('attempt_number')
      .execute();
    return rows.map(toAttempt);
  },

  // Compare and set, as for a payout. Dying goes through markDead, which carries
  // the proof.
  transition: async (
    db: Tx,
    id: string,
    move: {
      readonly from: AttemptStatusValue;
      readonly to: Exclude<AttemptStatusValue, 'dead'>;
      readonly onChainPayoutId?: string;
    },
  ): Promise<PayoutAttempt | undefined> => {
    await assertTransition(db, 'payout_attempt', move.from, move.to);
    const row = await db
      .updateTable('ujira.payout_attempts')
      .set({
        status: move.to,
        ...(move.onChainPayoutId === undefined ? {} : { on_chain_payout_id: move.onChainPayoutId }),
      })
      .where('id', '=', id)
      .where('status', '=', move.from)
      .returning(attemptColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toAttempt(row);
  },

  // The only way to free a payout for another attempt, and it takes the adapter's
  // proof that this one can never land.
  markDead: async (
    db: Tx,
    id: string,
    move: {
      readonly from: Exclude<AttemptStatusValue, 'dead' | 'final'>;
      readonly proof: Readonly<Record<string, unknown>>;
    },
  ): Promise<PayoutAttempt | undefined> => {
    await assertTransition(db, 'payout_attempt', move.from, 'dead');
    const row = await db
      .updateTable('ujira.payout_attempts')
      .set({ status: 'dead', dead_proof: proofJson(move.proof) })
      .where('id', '=', id)
      .where('status', '=', move.from)
      .returning(attemptColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toAttempt(row);
  },
};

export interface FundingHoldInput {
  readonly mandateInstanceId: string;
  // What a deposit on this network releases the hold by. Must be on the needed
  // amount's chain.
  readonly network: NetworkId;
  readonly needed: TokenAmount;
}

export interface FundingHold {
  readonly payoutId: string;
  readonly network: NetworkId;
  readonly mandateInstanceId: string;
  readonly needed: TokenAmount;
  readonly heldAt: Date;
}

const holdColumns = [
  'payout_id',
  'network',
  'chain',
  'mandate_instance_id',
  'needed_amount',
  'asset',
  'scale',
  'held_at',
] as const;

function toHold(row: {
  payout_id: string;
  network: string;
  chain: string;
  mandate_instance_id: string;
  needed_amount: string;
  asset: string;
  scale: number;
  held_at: Date;
}): FundingHold {
  return {
    payoutId: row.payout_id,
    network: row.network,
    mandateInstanceId: row.mandate_instance_id,
    needed: tokenFromRow({
      amount: row.needed_amount,
      asset: row.asset,
      chain: row.chain,
      scale: row.scale,
    }),
    heldAt: row.held_at,
  };
}

export const fundingHolds = {
  // One row per candidate network. False when the payout is not a received one
  // waiting on nothing but a network, so nothing was held.
  hold: async (db: Tx, payoutId: string, holds: readonly FundingHoldInput[]): Promise<boolean> => {
    // With no candidate no deposit would ever release it.
    if (holds.length === 0) throw new Error('a funding hold needs at least one candidate network');
    const moved = await db
      .updateTable('ujira.payouts')
      .set({ status_reason: 'awaiting_funding' })
      .where('id', '=', payoutId)
      .where('status', '=', 'received')
      .where((where) =>
        where.or([
          where('status_reason', 'is', null),
          where('status_reason', '=', 'network_unavailable'),
        ]),
      )
      .executeTakeFirst();
    if (moved.numUpdatedRows === 0n) return false;
    await db
      .insertInto('ujira.payout_funding_holds')
      .values(
        holds.map((hold) => ({
          principal_id: CURRENT_PRINCIPAL,
          project_id: CURRENT_PROJECT,
          payout_id: payoutId,
          network: hold.network,
          chain: hold.needed.chain,
          mandate_instance_id: hold.mandateInstanceId,
          needed_amount: amountParam(hold.needed),
          asset: hold.needed.asset,
          scale: hold.needed.scale,
        })),
      )
      .execute();
    return true;
  },

  // Every hold of the payout on every network, in the transaction that moves it
  // on. The commit is refused if a payout leaves the held state with any left.
  release: async (db: Tx, payoutId: string): Promise<number> => {
    const deleted = await db
      .deleteFrom('ujira.payout_funding_holds')
      .where('payout_id', '=', payoutId)
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  },

  // Oldest first, which is the order a deposit releases them in.
  oldestOnNetwork: async (
    db: Tx,
    network: string,
    limit: number,
  ): Promise<readonly FundingHold[]> => {
    const rows = await db
      .selectFrom('ujira.payout_funding_holds')
      .select(holdColumns)
      .where('network', '=', network)
      .orderBy('held_at')
      .orderBy('payout_id')
      .limit(checkedLimit(limit))
      .execute();
    return rows.map(toHold);
  },

  // The nightly consistency check, which should always find nothing. The triggers
  // stop this happening; this is what would notice if something got around them.
  inconsistentPayoutIds: async (db: Tx): Promise<readonly string[]> => {
    const rows = await db
      .selectFrom('ujira.payout_funding_holds as h')
      .innerJoin('ujira.payouts as p', (join) =>
        join
          .onRef('p.principal_id', '=', 'h.principal_id')
          .onRef('p.project_id', '=', 'h.project_id')
          .onRef('p.id', '=', 'h.payout_id'),
      )
      .select('h.payout_id')
      .distinct()
      .where((where) =>
        where.or([
          where('p.status', '<>', 'received'),
          where('p.status_reason', 'is', null),
          where('p.status_reason', '<>', 'awaiting_funding'),
        ]),
      )
      .execute();
    return rows.map((row) => row.payout_id);
  },
};

export interface ProjectPayoutMinimum {
  readonly method: string;
  readonly minimum: MinimumAmount;
  readonly setBy: string;
}

export const payoutMinimums = {
  list: async (db: Tx): Promise<readonly ProjectPayoutMinimum[]> => {
    const rows = await db
      .selectFrom('ujira.project_payout_minimums')
      .select(['method', 'currency', 'scale', 'min_amount', 'set_by'])
      .orderBy('method')
      .orderBy('currency')
      .execute();
    return rows.map((row) => ({
      method: row.method,
      minimum: { amount: BigInt(row.min_amount), currency: row.currency, scale: row.scale },
      setBy: row.set_by,
    }));
  },

  // Sets the project's minimum for one method and currency, and writes the audit
  // row in the same transaction. Setting the same value writes nothing.
  set: async (
    db: Tx,
    input: {
      readonly method: PayoutMinimumMethod;
      readonly minimum: MinimumAmount;
      readonly memberId: string;
    },
  ): Promise<void> => {
    const previous = await db
      .selectFrom('ujira.project_payout_minimums')
      .select(['min_amount', 'scale'])
      .where('method', '=', input.method)
      .where('currency', '=', input.minimum.currency)
      .forUpdate()
      .executeTakeFirst();
    const amount = input.minimum.amount.toString();
    if (previous?.min_amount === amount && previous.scale === input.minimum.scale) return;
    await db
      .insertInto('ujira.project_payout_minimums')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        method: input.method,
        currency: input.minimum.currency,
        scale: input.minimum.scale,
        min_amount: amount,
        set_by: input.memberId,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'method', 'currency']).doUpdateSet({
          scale: input.minimum.scale,
          min_amount: amount,
          set_by: input.memberId,
        }),
      )
      .execute();
    const actor: AuditActor = { kind: 'member', id: input.memberId };
    await audit.record(db, {
      action: 'project.payout_minimums_changed',
      actor,
      metadata: {
        method: input.method,
        currency: input.minimum.currency,
        scale: input.minimum.scale,
        old_value: previous?.min_amount ?? null,
        new_value: amount,
      },
    });
  },
};

export const payoutRepositories = {
  payouts,
  payoutBatches,
  payoutAttempts,
  fundingHolds,
  payoutMinimums,
} as const;
