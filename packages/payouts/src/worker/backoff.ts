// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The handler's own retry curve. The library's built in delay cannot be
// configured and reaches six hours per try, far too long for a payout waiting on
// a brief outage. So a handler that hits a retryable error enqueues itself again
// and returns, and the built in attempts stay as the net for crashes and bugs.

export const DEAD_LETTER_TRY = 12;

const FIRST_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 600;

// How long to wait after try `tryNumber` fails.
export function retryDelaySeconds(tryNumber: number): number {
  if (!Number.isSafeInteger(tryNumber) || tryNumber < 1) {
    throw new RangeError('a try number is a whole number from 1');
  }
  // Past the cap the exponent only grows, so it is capped as well, which keeps
  // the sum exact however large the try number.
  const doublings = Math.min(tryNumber - 1, 16);
  return Math.min(MAX_DELAY_SECONDS, FIRST_DELAY_SECONDS * 2 ** doublings);
}

export type NextStep =
  | { readonly kind: 'retry'; readonly tryNumber: number; readonly delaySeconds: number }
  | { readonly kind: 'dead_letter' };

export function afterFailure(tryNumber: number): NextStep {
  if (tryNumber >= DEAD_LETTER_TRY) return { kind: 'dead_letter' };
  return {
    kind: 'retry',
    tryNumber: tryNumber + 1,
    delaySeconds: retryDelaySeconds(tryNumber),
  };
}
