// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The smallest amount a payout may ask for. The minimum is the largest of the
// method's floor, the anchor's own minimum, the project's minimum and, once the
// month's uncovered network cost budget is spent, the break-even total, so a
// project minimum can only ever raise it. Nothing here reads a chain or an
// anchor: the caller brings those figures, and the conversion to USD.
//
// All of it is exact. Amounts of different scales are compared by cross
// multiplying bigints.

export const PAYOUT_MINIMUM_METHODS = [
  'stellar_wallet',
  'bank',
  'mobile_money',
  'cash_pickup',
] as const;

export type PayoutMinimumMethod = (typeof PAYOUT_MINIMUM_METHODS)[number];

export type MinimumReason = 'ujira_floor' | 'anchor_min' | 'project_min' | 'network_budget';

export interface MinimumAmount {
  readonly amount: bigint;
  // A currency code, or a token asset.
  readonly currency: string;
  readonly scale: number;
}

// Turns an amount into USD or USDC. Undefined when no rate is known.
export type ToUsd = (value: MinimumAmount) => MinimumAmount | undefined;

export interface PayoutMinimumContext {
  // The anchor's min_amount, for a method an anchor serves.
  readonly anchorMinimum?: MinimumAmount | null;
  // The break-even total, once the month's network budget is spent.
  readonly breakEvenMinimum?: MinimumAmount | null;
  // Needed as soon as an amount here is in neither USD nor USDC.
  readonly toUsd?: ToUsd;
}

export interface RequiredMinimum {
  readonly minimum: MinimumAmount;
  readonly reason: MinimumReason;
}

// Refused with this at creation, and surfaced by the API as a 422.
export class AmountBelowMinimumError extends Error {
  readonly code = 'AMOUNT_BELOW_MINIMUM';
  readonly method: PayoutMinimumMethod;
  readonly minimum: MinimumAmount;
  readonly reason: MinimumReason;

  constructor(method: PayoutMinimumMethod, required: RequiredMinimum) {
    super(`the amount is below the minimum for ${method}`);
    this.name = 'AmountBelowMinimumError';
    this.method = method;
    this.minimum = required.minimum;
    this.reason = required.reason;
  }
}

// With no rate the amount cannot be shown to clear the minimum, and a payout that
// might be below it must not go through.
export class MinimumNotComparableError extends Error {
  constructor(currency: string) {
    super(`no USD rate for ${currency}, so the payout minimum cannot be checked`);
    this.name = 'MinimumNotComparableError';
  }
}

const USD_VALUED: ReadonlySet<string> = new Set(['USD', 'USDC']);

// The floors. USDC and USD are taken at par here: a floor is a policy line, not a
// price.
const METHOD_FLOORS: Readonly<Record<PayoutMinimumMethod, MinimumAmount>> = {
  stellar_wallet: { amount: 100n, currency: 'USDC', scale: 2 },
  mobile_money: { amount: 200n, currency: 'USD', scale: 2 },
  bank: { amount: 500n, currency: 'USD', scale: 2 },
  cash_pickup: { amount: 1000n, currency: 'USD', scale: 2 },
};

function inUsd(value: MinimumAmount, toUsd: ToUsd | undefined): MinimumAmount {
  if (USD_VALUED.has(value.currency)) return value;
  const converted = toUsd?.(value);
  if (converted === undefined || !USD_VALUED.has(converted.currency)) {
    throw new MinimumNotComparableError(value.currency);
  }
  return converted;
}

function compare(a: MinimumAmount, b: MinimumAmount): number {
  const left = a.amount * 10n ** BigInt(b.scale);
  const right = b.amount * 10n ** BigInt(a.scale);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function requiredMinimum(
  method: PayoutMinimumMethod,
  projectMinimums: readonly MinimumAmount[],
  context: PayoutMinimumContext,
): RequiredMinimum {
  const candidates: RequiredMinimum[] = [{ minimum: METHOD_FLOORS[method], reason: 'ujira_floor' }];
  if (context.anchorMinimum != null) {
    candidates.push({ minimum: context.anchorMinimum, reason: 'anchor_min' });
  }
  for (const minimum of projectMinimums) candidates.push({ minimum, reason: 'project_min' });
  if (context.breakEvenMinimum != null) {
    candidates.push({ minimum: context.breakEvenMinimum, reason: 'network_budget' });
  }
  let highest: RequiredMinimum | undefined;
  let highestUsd: MinimumAmount | undefined;
  for (const candidate of candidates) {
    const usd = inUsd(candidate.minimum, context.toUsd);
    // Strictly above, so a tie names the earlier, more basic reason.
    if (highestUsd === undefined || compare(usd, highestUsd) > 0) {
      highest = candidate;
      highestUsd = usd;
    }
  }
  if (highest === undefined) throw new Error('a method always has a floor');
  return highest;
}

export function checkMinimum(
  method: PayoutMinimumMethod,
  asked: MinimumAmount,
  projectMinimums: readonly MinimumAmount[],
  context: PayoutMinimumContext,
): void {
  const required = requiredMinimum(method, projectMinimums, context);
  const askedUsd = inUsd(asked, context.toUsd);
  if (compare(askedUsd, inUsd(required.minimum, context.toUsd)) < 0) {
    throw new AmountBelowMinimumError(method, required);
  }
}
