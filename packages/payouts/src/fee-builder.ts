// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The contract only caps the fee; UJIRA decides it. Every payout UJIRA builds
// carries the fee from the principal's agreed terms in force when the payout
// was requested, never above the mandate's own cap, and none at all for
// payouts UJIRA makes at cost. The fee is UJIRA's take and nothing else: no
// network fee, rent, activation or anchor cost is ever added to it.

import { add, compare, feeCap } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';
import type { PayRequest, TenantScope } from '@ujira/chain-adapter';

export const FEE_BASES = Object.freeze([
  'standard',
  'committed_volume',
  'negotiated',
  'internal_at_cost',
] as const);
export type FeeBasis = (typeof FEE_BASES)[number];

/** One row of a project's fee terms. */
export interface FeeTerms {
  readonly id: string;
  /** Basis points, 0 to 100. */
  readonly rateBps: number;
  readonly basis: FeeBasis;
  readonly validFrom: Date;
}

/**
 * The project's fee terms with the latest valid_from at or before an instant,
 * or null when it has none yet. The database version is fees.termsAt.
 */
export interface FeeTermsSource {
  termsAt(
    scope: TenantScope,
    at: Date,
    opts: { readonly signal: AbortSignal },
  ): Promise<FeeTerms | null>;
}

/** What the attempt records, and what the request carries. */
export interface AppliedFee {
  readonly total: TokenAmount;
  readonly fee: TokenAmount;
  readonly bpsApplied: number;
  /** Named even when the fee is 0 by policy, so every fee traces to its terms. */
  readonly termsId: string;
  /** What leaves the mandate: total plus fee. */
  readonly charged: TokenAmount;
}

/** A project with no fee terms. Nothing is priced on a guess. */
export class FeeTermsMissingError extends Error {
  override readonly name = 'FeeTermsMissingError';
  readonly code = 'FEE_TERMS_MISSING';

  constructor() {
    super('The project has no fee terms in force');
  }
}

/** Terms that were not yet in force at the instant they were chosen for. */
export class FeeTermsNotInForceError extends Error {
  override readonly name = 'FeeTermsNotInForceError';
  readonly code = 'FEE_TERMS_NOT_IN_FORCE';

  constructor() {
    super('The fee terms were not in force when the payout was requested');
  }
}

/**
 * The fee for one payout under one set of terms and the mandate's cap. The
 * applied rate is the lower of the terms and the cap, and at-cost terms apply
 * 0 whatever their rate says.
 */
export function applyFee(total: TokenAmount, terms: FeeTerms, maxFeeBps: number): AppliedFee {
  const bpsApplied = terms.basis === 'internal_at_cost' ? 0 : Math.min(terms.rateBps, maxFeeBps);
  const fee = feeCap(total, bpsApplied);
  return Object.freeze({
    total,
    fee,
    bpsApplied,
    termsId: terms.id,
    charged: add(total, fee),
  });
}

const TERMS_DEADLINE_MS = 5_000;

/**
 * Looks up the terms in force when the payout was requested and applies them.
 * The request time, not the time the job happens to run, decides: a payout
 * requested today is never priced on terms that start tomorrow.
 */
export async function feeForPayout(
  input: {
    readonly scope: TenantScope;
    readonly total: TokenAmount;
    readonly requestedAt: Date;
    /** The mandate's own cap, read from its config on chain. */
    readonly maxFeeBps: number;
  },
  deps: { readonly terms: FeeTermsSource; readonly timeoutMs?: number },
): Promise<AppliedFee> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? TERMS_DEADLINE_MS);
  const terms = await deps.terms.termsAt(input.scope, input.requestedAt, { signal });
  if (terms === null) throw new FeeTermsMissingError();
  if (terms.validFrom.getTime() > input.requestedAt.getTime()) {
    throw new FeeTermsNotInForceError();
  }
  return applyFee(input.total, terms, input.maxFeeBps);
}

/** The request to pay, carrying the fee. Its total must be the one the fee was worked out on. */
export function withFee(request: Omit<PayRequest, 'fee'>, applied: AppliedFee): PayRequest {
  // compare also refuses two totals in different units.
  if (compare(request.total, applied.total) !== 0) {
    throw new RangeError('the fee was worked out on a different total');
  }
  return { ...request, fee: applied.fee };
}
