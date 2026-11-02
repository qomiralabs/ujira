// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a payout is expected to cost on the network, from what recent
// submissions actually cost. UJIRA sponsors every network fee and rent inside
// its take, and an executor's fee is only known after it lands, so the check
// before sending uses an estimate. It never appears on a customer line.
//
// Reading submissions and storing estimates are ports. The chain submissions
// table and the worker that runs the daily job land with their own issues, so
// this file holds the rules and they plug in the storage. All amounts are
// integer stroops.

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

export const REFRESH_FEE_ESTIMATES_JOB = 'payouts:refresh_fee_estimates';

/** The percentile window, in days. */
export const FEE_ESTIMATE_WINDOW_DAYS = 7;
/** fees.networkFee.marginBps: 12 percent. */
export const NETWORK_FEE_MARGIN_BPS = 1_200n;
const BPS = 10_000n;
const DAY_MS = 86_400_000;

/** One submission as the refresh reads it. */
export interface SubmissionFee {
  readonly network: string;
  readonly op: FeeEstimateOp;
  /** Legs per payout item. */
  readonly legCount: number;
  /** Payout items in the transaction: one, except for a batch. */
  readonly itemCount: number;
  readonly state: string;
  readonly landedAt: Date | null;
  /** Totals for the transaction. */
  readonly resourceFeeStroops: bigint;
  readonly rentStroops: bigint;
  readonly inclusionFeeStroops: bigint;
}

export interface FeeEstimateRow {
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

/** A submission that cannot be counted without corrupting the estimate. */
export class FeeEstimateInputError extends Error {
  override readonly name = 'FeeEstimateInputError';
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** The nearest-rank 95th percentile: the smallest value at or above 95 percent of them. */
export function percentile95(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = ceilDiv(95n * BigInt(sorted.length), 100n);
  const value = sorted[Number(rank) - 1];
  if (value === undefined) throw new FeeEstimateInputError('no values to take a percentile of');
  return value;
}

/**
 * The window a refresh reads: the 7 days before midnight UTC of its day. Tying
 * it to the day rather than the clock is what makes two runs on one day leave
 * the same rows, and a recompute after a change read the same submissions.
 */
export function feeEstimateWindow(now: Date): { readonly start: Date; readonly end: Date } {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: new Date(end - FEE_ESTIMATE_WINDOW_DAYS * DAY_MS), end: new Date(end) };
}

function checkSubmission(s: SubmissionFee): void {
  const amounts = [s.resourceFeeStroops, s.rentStroops, s.inclusionFeeStroops];
  if (
    !Number.isSafeInteger(s.itemCount) ||
    s.itemCount < 1 ||
    amounts.some((amount) => amount < 0n) ||
    s.rentStroops > s.resourceFeeStroops
  ) {
    throw new FeeEstimateInputError(`a landed ${s.op} submission holds impossible amounts`);
  }
}

export interface ComputedEstimates {
  /** The combinations with enough samples. */
  readonly rows: readonly FeeEstimateRow[];
  /** The combinations seen with too few samples, which keep their previous row. */
  readonly sparse: readonly {
    readonly network: string;
    readonly op: FeeEstimateOp;
    readonly legCount: number;
    readonly sampleCount: number;
  }[];
}

/**
 * Each 95th percentile over the window. Only landed submissions inside it
 * count, never failed, unknown or simulated ones, and every fee is per payout
 * item, rounded up, so a batch contributes its fee divided by its items.
 */
export function computeFeeEstimates(
  submissions: readonly SubmissionFee[],
  options: { readonly now: Date; readonly sampleMinimum: number },
): ComputedEstimates {
  const { start, end } = feeEstimateWindow(options.now);
  const groups = new Map<
    string,
    {
      readonly identity: Pick<SubmissionFee, 'network' | 'op' | 'legCount'>;
      readonly items: SubmissionFee[];
    }
  >();
  for (const submission of submissions) {
    const landedAt = submission.landedAt;
    if (submission.state !== 'landed' || landedAt === null) continue;
    if (landedAt < start || landedAt >= end) continue;
    checkSubmission(submission);
    const { network, op, legCount } = submission;
    const key = `${network} ${op} ${String(legCount)}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { identity: { network, op, legCount }, items: [submission] });
    } else {
      group.items.push(submission);
    }
  }

  const rows: FeeEstimateRow[] = [];
  const sparse: ComputedEstimates['sparse'][number][] = [];
  for (const { identity, items } of groups.values()) {
    if (items.length < options.sampleMinimum) {
      sparse.push({ ...identity, sampleCount: items.length });
      continue;
    }
    const perItem = (read: (s: SubmissionFee) => bigint): bigint =>
      percentile95(items.map((s) => ceilDiv(read(s), BigInt(s.itemCount))));
    rows.push({
      ...identity,
      p95ResourceFeeStroops: perItem((s) => s.resourceFeeStroops),
      p95RentStroops: perItem((s) => s.rentStroops),
      p95InclusionFeeStroops: perItem((s) => s.inclusionFeeStroops),
      sampleCount: items.length,
      windowStart: start,
      windowEnd: end,
      computedAt: end,
    });
  }
  return { rows, sparse };
}

/** Everything the refresh job needs from outside. */
export interface RefreshFeeEstimatesPorts {
  /** Submissions recorded in the window. The refresh checks state and time itself. */
  readonly submissionsBetween: (start: Date, end: Date) => Promise<readonly SubmissionFee[]>;
  readonly currentEstimates: () => Promise<readonly FeeEstimateRow[]>;
  /** Writes every row in one transaction, so a reader never sees a half refreshed table. */
  readonly writeEstimates: (rows: readonly FeeEstimateRow[]) => Promise<void>;
  readonly alertSparse: (e: ComputedEstimates['sparse'][number]) => void;
}

/** A row's values, as text, since job output is JSON and these are bigints. */
export interface LoggedEstimate {
  readonly p95ResourceFeeStroops: string;
  readonly p95RentStroops: string;
  readonly p95InclusionFeeStroops: string;
  readonly sampleCount: number;
}

/** The job output. Nothing is retained beyond the current rows, so this is the history. */
export interface RefreshFeeEstimatesOutput {
  readonly written: number;
  readonly kept: number;
  readonly replaced: readonly {
    readonly network: string;
    readonly op: FeeEstimateOp;
    readonly legCount: number;
    readonly previous: LoggedEstimate | null;
    readonly current: LoggedEstimate;
  }[];
}

const logged = (row: FeeEstimateRow): LoggedEstimate => ({
  p95ResourceFeeStroops: row.p95ResourceFeeStroops.toString(),
  p95RentStroops: row.p95RentStroops.toString(),
  p95InclusionFeeStroops: row.p95InclusionFeeStroops.toString(),
  sampleCount: row.sampleCount,
});

/** The daily job: compute, alert on sparse data, write all rows at once, report what changed. */
export async function refreshFeeEstimates(
  ports: RefreshFeeEstimatesPorts,
  options: { readonly now: Date; readonly sampleMinimum: number },
): Promise<RefreshFeeEstimatesOutput> {
  const { start, end } = feeEstimateWindow(options.now);
  const submissions = await ports.submissionsBetween(start, end);
  const { rows, sparse } = computeFeeEstimates(submissions, options);
  const previous = await ports.currentEstimates();
  const key = (r: { network: string; op: string; legCount: number }): string =>
    `${r.network} ${r.op} ${String(r.legCount)}`;
  const before = new Map(previous.map((row) => [key(row), row]));
  await ports.writeEstimates(rows);
  // Alerted after the write, so a failed write is retried without repeating them.
  for (const combination of sparse) ports.alertSparse(combination);
  return {
    written: rows.length,
    kept: sparse.length,
    replaced: rows.map((row) => {
      const old = before.get(key(row));
      return {
        network: row.network,
        op: row.op,
        legCount: row.legCount,
        previous: old === undefined ? null : logged(old),
        current: logged(row),
      };
    }),
  };
}

/**
 * Rent depends on the payout TTL, so a change to the TTL defaults recomputes
 * the estimates. True when a refresh was enqueued.
 */
export async function onPayoutTtlDefaultsChanged(
  previous: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
  enqueue: (job: typeof REFRESH_FEE_ESTIMATES_JOB) => Promise<void>,
): Promise<boolean> {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  const changed = [...keys].some((key) => previous[key] !== current[key]);
  if (changed) await enqueue(REFRESH_FEE_ESTIMATES_JOB);
  return changed;
}

export interface NetworkFeeEstimate {
  readonly source: 'estimate' | 'simulation';
  /** With the margin, rounded up. Rent is part of this, reported apart. */
  readonly resourceFeeStroops: bigint;
  readonly rentStroops: bigint;
  /** This item's share of the transaction's inclusion fee, with the margin. */
  readonly inclusionFeeStroops: bigint;
}

/** No estimate on record and no simulation to fall back on. */
export class FeeEstimateUnavailableError extends Error {
  override readonly name = 'FeeEstimateUnavailableError';
}

function withMargin(stroops: bigint, marginBps: bigint): bigint {
  return ceilDiv(stroops * (BPS + marginBps), BPS);
}

export interface NetworkFeeEstimatorOptions {
  readonly lookup: (key: {
    readonly network: string;
    readonly op: FeeEstimateOp;
    readonly legCount: number;
  }) => Promise<FeeEstimateRow | undefined>;
  /** fees.networkFee.marginBps. */
  readonly marginBps?: bigint;
}

export type EstimateNetworkFee = (
  network: string,
  op: FeeEstimateOp,
  legCount: number,
  /** The request-time simulation, used when there is no row yet. */
  simulation?: {
    readonly resourceFeeStroops: bigint;
    readonly rentStroops: bigint;
    readonly inclusionFeeStroops: bigint;
  },
) => Promise<NetworkFeeEstimate>;

/** Builds estimateNetworkFee over the store. */
export function networkFeeEstimator(options: NetworkFeeEstimatorOptions): EstimateNetworkFee {
  const margin = options.marginBps ?? NETWORK_FEE_MARGIN_BPS;
  return async (network, op, legCount, simulation) => {
    const row = await options.lookup({ network, op, legCount });
    if (row !== undefined) {
      return {
        source: 'estimate',
        resourceFeeStroops: withMargin(row.p95ResourceFeeStroops, margin),
        rentStroops: withMargin(row.p95RentStroops, margin),
        inclusionFeeStroops: withMargin(row.p95InclusionFeeStroops, margin),
      };
    }
    if (simulation === undefined) {
      throw new FeeEstimateUnavailableError(`no estimate for ${op} on ${network}`);
    }
    return {
      source: 'simulation',
      resourceFeeStroops: withMargin(simulation.resourceFeeStroops, margin),
      rentStroops: withMargin(simulation.rentStroops, margin),
      inclusionFeeStroops: withMargin(simulation.inclusionFeeStroops, margin),
    };
  };
}
