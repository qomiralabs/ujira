// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The contract only stops overcharging, so a request built outside UJIRA with an
// integrator's own agent key can carry less than the agreed fee. This finds that, and
// finds any fee that did not reach the fee address. Only the take is compared. Network
// and anchor costs are never part of the fee, so they never appear here.

import { add, compare, tokenAmount } from '@ujira/core';
import type { TokenAmount, TokenAsset } from '@ujira/core';
import type { NetworkId, TenantScope, Uuid } from '@ujira/chain-adapter';

import { applyFee } from './fee-builder.js';
import type { FeeTerms } from './fee-builder.js';

const CALL_DEADLINE_MS = 30_000;
const PAGE_SIZE = 500;

export const FEE_OUTCOMES = Object.freeze(['matched', 'underpaid', 'mismatch'] as const);
export type FeeOutcome = (typeof FEE_OUTCOMES)[number];

export type FeeResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'invoiced'; readonly invoiceRef: string }
  | { readonly kind: 'waived' };

export interface FeeReconciliation {
  readonly expected: TokenAmount;
  readonly onChain: TokenAmount;
  readonly received: TokenAmount;
  /** What the agreed fee was short by, on what arrived. Above zero only when underpaid. */
  readonly shortfall: TokenAmount;
  readonly outcome: FeeOutcome;
}

/** The latest revision of one executed attempt's reconciliation. */
export interface FeeReconciliationRow extends FeeReconciliation {
  readonly scope: TenantScope;
  readonly attemptId: string;
  readonly revision: number;
  readonly network: NetworkId;
  readonly executedAt: Date;
  readonly resolution: FeeResolution;
}

/** Half open: from is in, to is not, so adjacent periods never count a fee twice. */
export interface FeePeriod {
  readonly from: Date;
  readonly to: Date;
}

export interface FeePageRequest {
  readonly after: string | null;
  readonly limit: number;
}

export interface FeePage {
  readonly rows: readonly FeeReconciliationRow[];
  readonly next: string | null;
}

interface StoreOptions {
  readonly signal: AbortSignal;
}

/** The fee_reconciliations table. Each read sees only the latest revision of an attempt. */
export interface FeeReconciliationStore {
  /** Every tenant on a network, so this one belongs to the job's own role. */
  executed(
    network: NetworkId,
    period: FeePeriod,
    page: FeePageRequest,
    opts: StoreOptions,
  ): Promise<FeePage>;
  underpaid(
    principalId: Uuid,
    period: FeePeriod,
    page: FeePageRequest,
    opts: StoreOptions,
  ): Promise<FeePage>;
  latest(
    scope: TenantScope,
    attemptId: string,
    opts: StoreOptions,
  ): Promise<FeeReconciliationRow | null>;
  /** False when that revision of the attempt already exists: someone else got there first. */
  appendRevision(row: FeeReconciliationRow, opts: StoreOptions): Promise<boolean>;
  /** The sum of the on chain fees, as one query over the period. */
  executedFeeTotal(
    network: NetworkId,
    asset: TokenAsset,
    period: FeePeriod,
    opts: StoreOptions,
  ): Promise<TokenAmount>;
}

export interface FeeAddressMovement {
  readonly opening: TokenAmount;
  readonly closing: TokenAmount;
  /** What UJIRA itself sent out, such as fee refunds. Not a divergence. */
  readonly knownOutflows: TokenAmount;
}

export interface FeeAddressLedger {
  movement(
    network: NetworkId,
    asset: TokenAsset,
    period: FeePeriod,
    opts: StoreOptions,
  ): Promise<FeeAddressMovement>;
}

export interface FeeMismatchAlert {
  /** Stable for the row, so a rerun of the job does not page anyone twice. */
  readonly key: string;
  readonly severity: 'high';
  readonly row: FeeReconciliationRow;
  readonly correlationId: string;
}

export interface FeeDivergenceAlert {
  readonly key: string;
  readonly severity: 'high';
  readonly network: NetworkId;
  readonly period: FeePeriod;
  readonly asset: TokenAsset;
  readonly chain: TokenAmount['chain'];
  readonly scale: number;
  /** Raw units of the asset. Positive when more arrived than the fees explain. */
  readonly difference: bigint;
  readonly correlationId: string;
}

export interface FeeAlerts {
  mismatch(alert: FeeMismatchAlert, opts: StoreOptions): Promise<void>;
  divergence(alert: FeeDivergenceAlert, opts: StoreOptions): Promise<void>;
}

export class InvalidFeePeriodError extends Error {
  override readonly name = 'InvalidFeePeriodError';
  readonly code = 'INVALID_FEE_PERIOD';

  constructor() {
    super('A fee period must end after it starts');
  }
}

/** A store answering a principal's report with another principal's row. Never shown. */
export class FeeReportForeignRowError extends Error {
  override readonly name = 'FeeReportForeignRowError';
  readonly code = 'FEE_REPORT_FOREIGN_ROW';

  constructor() {
    super('A fee report read returned a row of another principal');
  }
}

export class FeeReconciliationNotFoundError extends Error {
  override readonly name = 'FeeReconciliationNotFoundError';
  readonly code = 'FEE_RECONCILIATION_NOT_FOUND';

  constructor() {
    super('No fee reconciliation for that attempt');
  }
}

/**
 * Only a principal's own underpayment can be invoiced or waived. A mismatch has to be
 * explained, and a fee the chain says was taken has already been paid by the principal.
 */
export class FeeNotUnderpaidError extends Error {
  override readonly name = 'FeeNotUnderpaidError';
  readonly code = 'FEE_NOT_UNDERPAID';

  constructor() {
    super('Only an underpaid fee can be resolved');
  }
}

/** Already resolved another way. Changing it is a decision, not a retry. */
export class FeeResolutionConflictError extends Error {
  override readonly name = 'FeeResolutionConflictError';
  readonly code = 'FEE_RESOLUTION_CONFLICT';

  constructor() {
    super('The fee has already been resolved differently');
  }
}

function checkedPeriod(period: FeePeriod): FeePeriod {
  if (period.from.getTime() >= period.to.getTime()) throw new InvalidFeePeriodError();
  return period;
}

function zeroOf(amount: TokenAmount): TokenAmount {
  return tokenAmount(0n, amount.asset, amount.chain);
}

/**
 * Compares one executed fee with the terms. The expected fee is worked out exactly as the
 * builder prices a payout, on the total as requested. A total grossed up to cover a cost
 * has the take on that total, and the cost itself is not in the fee.
 *
 * The outcome and shortfall are the ones the table's checks hold a row to, and they go by
 * what arrived, so there is one definition of each. Anything above the expected fee is a
 * mismatch and not a pass: a principal paid more than agreed, and that is ours to put right.
 */
export function reconcileFee(input: {
  readonly total: TokenAmount;
  readonly terms: FeeTerms;
  readonly maxFeeBps: number;
  readonly onChain: TokenAmount;
  readonly received: TokenAmount;
}): FeeReconciliation {
  const { onChain, received } = input;
  const { fee: expected } = applyFee(input.total, input.terms, input.maxFeeBps);
  const arrived = compare(received, expected);
  const exact = arrived === 0 && compare(onChain, received) === 0;
  const outcome: FeeOutcome = exact ? 'matched' : arrived < 0 ? 'underpaid' : 'mismatch';
  const shortfall =
    arrived < 0
      ? tokenAmount(expected.amount - received.amount, expected.asset, expected.chain)
      : zeroOf(expected);
  return { expected, onChain, received, shortfall, outcome };
}

// The chain says it took one amount and another arrived. That reads as underpaid when less
// arrived, but it is not a principal paying too little: the money went somewhere.
function lostOnTheWay(row: FeeReconciliation): boolean {
  return compare(row.onChain, row.received) !== 0;
}

async function* pagesOf(
  read: (page: FeePageRequest, opts: StoreOptions) => Promise<FeePage>,
  timeoutMs: number,
): AsyncGenerator<readonly FeeReconciliationRow[]> {
  let after: string | null = null;
  do {
    const page: FeePage = await read(
      { after, limit: PAGE_SIZE },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    yield page.rows;
    after = page.next;
  } while (after !== null);
}

export interface FeeReconcileDeps {
  readonly store: FeeReconciliationStore;
  readonly alerts: FeeAlerts;
  readonly timeoutMs?: number;
}

export interface FeeReconcileSummary {
  readonly matched: number;
  readonly underpaid: number;
  readonly mismatch: number;
}

/**
 * Reads a network's executed fees for a period, and raises every mismatch and every fee that
 * did not arrive as the chain says at high severity.
 */
export async function runFeeReconciliation(
  input: {
    readonly network: NetworkId;
    readonly period: FeePeriod;
    readonly correlationId: string;
  },
  deps: FeeReconcileDeps,
): Promise<FeeReconcileSummary> {
  const { network, correlationId } = input;
  const period = checkedPeriod(input.period);
  const timeoutMs = deps.timeoutMs ?? CALL_DEADLINE_MS;
  const counts = { matched: 0, underpaid: 0, mismatch: 0 };
  const read = (page: FeePageRequest, opts: StoreOptions) =>
    deps.store.executed(network, period, page, opts);
  for await (const rows of pagesOf(read, timeoutMs)) {
    for (const row of rows) {
      counts[row.outcome] += 1;
      if (row.outcome !== 'mismatch' && !lostOnTheWay(row)) continue;
      await deps.alerts.mismatch(
        {
          key: `fee-mismatch:${row.attemptId}:${String(row.revision)}`,
          severity: 'high',
          row,
          correlationId,
        },
        { signal: AbortSignal.timeout(timeoutMs) },
      );
    }
  }
  return counts;
}

export type FeeBalanceCheck =
  { readonly kind: 'clean' } | { readonly kind: 'diverged'; readonly difference: bigint };

/**
 * What arrived at the fee address must equal the fees the chain says it paid, less what
 * UJIRA sent out itself. A difference means a fee went missing or money arrived that no
 * fee explains, and neither is something this can settle, so it alerts.
 */
export async function checkFeeAddressBalance(
  input: {
    readonly network: NetworkId;
    readonly asset: TokenAsset;
    readonly period: FeePeriod;
    readonly correlationId: string;
  },
  deps: {
    readonly store: Pick<FeeReconciliationStore, 'executedFeeTotal'>;
    readonly ledger: FeeAddressLedger;
    readonly alerts: FeeAlerts;
    readonly timeoutMs?: number;
  },
): Promise<FeeBalanceCheck> {
  const { network, asset, correlationId } = input;
  const period = checkedPeriod(input.period);
  const signal = AbortSignal.timeout(deps.timeoutMs ?? CALL_DEADLINE_MS);
  const { opening, closing, knownOutflows } = await deps.ledger.movement(network, asset, period, {
    signal,
  });
  const fees = await deps.store.executedFeeTotal(network, asset, period, { signal });
  // compare refuses two amounts in different units, which would make this sum meaningless.
  compare(opening, closing);
  compare(closing, fees);
  compare(fees, knownOutflows);
  const difference = closing.amount - opening.amount - (fees.amount - knownOutflows.amount);
  if (difference === 0n) return { kind: 'clean' };
  await deps.alerts.divergence(
    {
      key: `fee-divergence:${network}:${asset}:${period.from.toISOString()}:${period.to.toISOString()}`,
      severity: 'high',
      network,
      period,
      asset,
      chain: closing.chain,
      scale: closing.scale,
      difference,
      correlationId,
    },
    { signal },
  );
  return { kind: 'diverged', difference };
}

export interface UnderpaidFeeReport {
  readonly principalId: Uuid;
  readonly period: FeePeriod;
  /** Every underpaid fee in the period, in every project of the principal. */
  readonly items: readonly FeeReconciliationRow[];
  /** What is still neither invoiced nor waived, one amount per token. */
  readonly open: readonly TokenAmount[];
}

export async function underpaidFeeReport(
  input: { readonly principalId: Uuid; readonly period: FeePeriod },
  deps: {
    readonly store: Pick<FeeReconciliationStore, 'underpaid'>;
    readonly timeoutMs?: number;
  },
): Promise<UnderpaidFeeReport> {
  const { principalId } = input;
  const period = checkedPeriod(input.period);
  const items: FeeReconciliationRow[] = [];
  const open = new Map<string, TokenAmount>();
  const read = (page: FeePageRequest, opts: StoreOptions) =>
    deps.store.underpaid(principalId, period, page, opts);
  for await (const rows of pagesOf(read, deps.timeoutMs ?? CALL_DEADLINE_MS)) {
    for (const row of rows) {
      if (row.scope.principalId !== principalId) throw new FeeReportForeignRowError();
      items.push(row);
      if (row.resolution.kind !== 'none') continue;
      const key = `${row.shortfall.chain}/${row.shortfall.asset}`;
      const sum = open.get(key);
      open.set(key, sum === undefined ? row.shortfall : add(sum, row.shortfall));
    }
  }
  return { principalId, period, items, open: [...open.values()] };
}

function sameResolution(a: FeeResolution, b: FeeResolution): boolean {
  if (a.kind === 'invoiced' && b.kind === 'invoiced') return a.invoiceRef === b.invoiceRef;
  return a.kind === b.kind;
}

/**
 * Operations settling an underpaid fee: a new revision, since these rows are money records
 * and are never edited. The same answer twice is a retry and changes nothing.
 */
export async function resolveUnderpaidFee(
  input: {
    readonly scope: TenantScope;
    readonly attemptId: string;
    readonly resolution: Exclude<FeeResolution, { readonly kind: 'none' }>;
    readonly timeoutMs?: number;
  },
  deps: { readonly store: Pick<FeeReconciliationStore, 'latest' | 'appendRevision'> },
): Promise<FeeReconciliationRow> {
  const { scope, attemptId, resolution } = input;
  const opts = { signal: AbortSignal.timeout(input.timeoutMs ?? CALL_DEADLINE_MS) };
  const read = async (): Promise<FeeReconciliationRow> => {
    const row = await deps.store.latest(scope, attemptId, opts);
    if (row === null) throw new FeeReconciliationNotFoundError();
    if (row.outcome !== 'underpaid' || lostOnTheWay(row)) throw new FeeNotUnderpaidError();
    if (row.resolution.kind !== 'none' && !sameResolution(row.resolution, resolution)) {
      throw new FeeResolutionConflictError();
    }
    return row;
  };
  const current = await read();
  if (current.resolution.kind !== 'none') return current;
  const next: FeeReconciliationRow = { ...current, revision: current.revision + 1, resolution };
  if (await deps.store.appendRevision(next, opts)) return next;
  // Lost a race. If the winner said the same thing this is that decision, and if not,
  // two people disagreed and neither answer is taken silently.
  const raced = await read();
  if (raced.resolution.kind === 'none') throw new FeeResolutionConflictError();
  return raced;
}
