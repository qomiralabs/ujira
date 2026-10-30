// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How a job treats each signer failure. The job layer looks the rule up by
// the error's code instead of keeping its own copy, so the two can never
// disagree about whether a refusal is worth another try.

import { InvalidInputError } from './errors.js';
import type { ChainAdapterErrorCode } from './errors.js';

export const SIGNER_ERROR_CODES = Object.freeze([
  'SIGNER_UNAVAILABLE',
  'SIGNER_DENIED',
  'SIGNER_ADDRESS_MISMATCH',
] as const satisfies readonly ChainAdapterErrorCode[]);

export type SignerErrorCode = (typeof SIGNER_ERROR_CODES)[number];

/** Operations hear about outages; security hears about refusals and wrong keys. */
export type AlertKind = 'ops' | 'security';

export interface RetryRule {
  /** Attempts in all, the first included. One means the first failure is final. */
  readonly maxAttempts: number;
  /** The first wait, doubling after each retry up to the cap; null when there is no retry. */
  readonly backoff: { readonly firstMs: number; readonly maxMs: number } | null;
  /** Raised when the job gives up and goes to the dead letter queue. */
  readonly alert: AlertKind;
  /** The network reports degraded for as long as the error lasts. */
  readonly degradesNetwork: boolean;
  /** Raised by the startup key check, the service exits instead of taking work. */
  readonly stopsStartup: boolean;
}

export const SIGNER_RETRY_RULES: Readonly<Record<SignerErrorCode, RetryRule>> = Object.freeze({
  // Twelve attempts mean eleven waits, the last three at the five minute
  // cap, so a payout rides out roughly 25 minutes of outage before it parks.
  SIGNER_UNAVAILABLE: Object.freeze({
    maxAttempts: 12,
    backoff: Object.freeze({ firstMs: 2_000, maxMs: 300_000 }),
    alert: 'ops',
    degradesNetwork: true,
    stopsStartup: false,
  }),
  SIGNER_DENIED: Object.freeze({
    maxAttempts: 1,
    backoff: null,
    alert: 'security',
    degradesNetwork: false,
    stopsStartup: false,
  }),
  SIGNER_ADDRESS_MISMATCH: Object.freeze({
    maxAttempts: 1,
    backoff: null,
    alert: 'security',
    degradesNetwork: false,
    stopsStartup: true,
  }),
});

const SIGNER_CODES: ReadonlySet<unknown> = new Set<unknown>(SIGNER_ERROR_CODES);

export function isSignerErrorCode(code: unknown): code is SignerErrorCode {
  return SIGNER_CODES.has(code);
}

export type RetryDecision =
  | { readonly action: 'retry'; readonly delayMs: number }
  | { readonly action: 'dead_letter'; readonly alert: AlertKind };

/**
 * What a job does after its `attempt`th try, counting from one, failed with
 * a signer error. Each wait is its step plus up to half again at random,
 * never past the cap, so jobs that failed together do not all come back
 * together. `random` returns a number in [0, 1) and is passed in so tests
 * can pin it.
 */
export function signerRetryDecision(
  code: SignerErrorCode,
  attempt: number,
  random: () => number = Math.random,
): RetryDecision {
  if (!isSignerErrorCode(code)) throw new InvalidInputError({ issues: ['code (invalid)'] });
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new InvalidInputError({ issues: ['attempt (invalid)'] });
  }
  const rule = SIGNER_RETRY_RULES[code];
  if (rule.backoff === null || attempt >= rule.maxAttempts) {
    return { action: 'dead_letter', alert: rule.alert };
  }
  const { firstMs, maxMs } = rule.backoff;
  const step = Math.min(maxMs, firstMs * 2 ** (attempt - 1));
  const draw = random();
  if (!(draw >= 0 && draw < 1)) throw new InvalidInputError({ issues: ['random (out_of_range)'] });
  return { action: 'retry', delayMs: Math.min(maxMs, step + Math.floor((draw * step) / 2)) };
}
