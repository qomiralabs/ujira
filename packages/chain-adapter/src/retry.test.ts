// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the signer retry rules (retry.ts).
 *
 * signerRetryDecision(code, attempt, random) says what a job does after its
 * attempt-th try (from 1) failed with a signer error:
 * - SIGNER_UNAVAILABLE: retry from 2 s, doubling to a 5 minute cap, each
 *   wait plus up to half again at random and never past the cap, at most
 *   12 attempts, then the dead letter queue with an ops alert. The network
 *   reports degraded meanwhile.
 * - SIGNER_DENIED: no retry, dead letter with a security alert.
 * - SIGNER_ADDRESS_MISMATCH: no retry, security alert, and raised by the
 *   startup key check it stops the service.
 * A code outside the three, an attempt that is not a whole number from 1,
 * or a random draw outside [0, 1) throws InvalidInputError.
 */

import { describe, expect, it } from 'vitest';

import {
  InvalidInputError,
  SIGNER_ERROR_CODES,
  SIGNER_RETRY_RULES,
  SignerAddressMismatchError,
  SignerDeniedError,
  SignerUnavailableError,
  isSignerErrorCode,
  signerRetryDecision,
} from './index.js';
import type { ChainAdapterError, SignerErrorCode } from './index.js';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

const LOW = () => 0;
const HIGH = () => 0.999_999;

// Code, error class, max attempts, alert, degrades the network, stops startup.
const TABLE: [SignerErrorCode, new () => ChainAdapterError, number, string, boolean, boolean][] = [
  ['SIGNER_UNAVAILABLE', SignerUnavailableError, 12, 'ops', true, false],
  ['SIGNER_DENIED', SignerDeniedError, 1, 'security', false, false],
  ['SIGNER_ADDRESS_MISMATCH', SignerAddressMismatchError, 1, 'security', false, true],
];

describe('signer retry rules', () => {
  it.each(TABLE)(
    '%s retries per its rule',
    (code, ErrorClass, maxAttempts, alert, degradesNetwork, stopsStartup) => {
      const rule = SIGNER_RETRY_RULES[code];
      expect(rule.maxAttempts).toBe(maxAttempts);
      expect(rule.alert).toBe(alert);
      expect(rule.degradesNetwork).toBe(degradesNetwork);
      expect(rule.stopsStartup).toBe(stopsStartup);
      // The error's own retryable flag agrees with the rule.
      const err = new ErrorClass();
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(maxAttempts > 1);
      expect(err.landed).toBe('no');
      // Every attempt short of the last retries; the last parks the job.
      for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
        expect(signerRetryDecision(code, attempt, LOW).action).toBe('retry');
      }
      expect(signerRetryDecision(code, maxAttempts, LOW)).toEqual({ action: 'dead_letter', alert });
      expect(signerRetryDecision(code, maxAttempts + 5, LOW)).toEqual({
        action: 'dead_letter',
        alert,
      });
    },
  );

  it('covers exactly the three signer codes', () => {
    expect([...SIGNER_ERROR_CODES].sort()).toEqual(TABLE.map(([code]) => code).sort());
    expect(Object.keys(SIGNER_RETRY_RULES).sort()).toEqual([...SIGNER_ERROR_CODES].sort());
    expect(Object.isFrozen(SIGNER_RETRY_RULES)).toBe(true);
    expect(Object.isFrozen(SIGNER_RETRY_RULES.SIGNER_UNAVAILABLE)).toBe(true);
    for (const code of SIGNER_ERROR_CODES) expect(isSignerErrorCode(code)).toBe(true);
    for (const other of ['SPONSOR_DENIED', 'SIGNED_PAYLOAD_MISMATCH', '', null, 7]) {
      expect(isSignerErrorCode(other)).toBe(false);
    }
  });

  it('SIGNER_UNAVAILABLE waits from 2 s, doubling to the 5 minute cap', () => {
    const waits = (random: () => number) =>
      Array.from({ length: 11 }, (_, i) => {
        const decision = signerRetryDecision('SIGNER_UNAVAILABLE', i + 1, random);
        return decision.action === 'retry' ? decision.delayMs : -1;
      });
    expect(waits(LOW)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000,
    ]);
    // Jitter adds up to half of the step, and the cap still holds.
    expect(waits(HIGH)).toEqual([
      2_999, 5_999, 11_999, 23_999, 47_999, 95_999, 191_999, 300_000, 300_000, 300_000, 300_000,
    ]);
    const half = signerRetryDecision('SIGNER_UNAVAILABLE', 1, () => 0.5);
    expect(half).toEqual({ action: 'retry', delayMs: 2_500 });
  });

  it('draws once per decision with the default random source', () => {
    for (let i = 0; i < 50; i += 1) {
      const decision = signerRetryDecision('SIGNER_UNAVAILABLE', 1);
      expect(decision.action).toBe('retry');
      if (decision.action === 'retry') {
        expect(decision.delayMs).toBeGreaterThanOrEqual(2_000);
        expect(decision.delayMs).toBeLessThan(3_000);
        expect(Number.isSafeInteger(decision.delayMs)).toBe(true);
      }
    }
  });

  it('refuses a bad attempt, code or random draw', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(thrown(() => signerRetryDecision('SIGNER_UNAVAILABLE', attempt))).toBeInstanceOf(
        InvalidInputError,
      );
    }
    expect(thrown(() => signerRetryDecision('SPONSOR_DENIED' as never, 1))).toBeInstanceOf(
      InvalidInputError,
    );
    for (const draw of [1, -0.1, Number.NaN]) {
      expect(thrown(() => signerRetryDecision('SIGNER_UNAVAILABLE', 1, () => draw))).toBeInstanceOf(
        InvalidInputError,
      );
    }
  });
});
