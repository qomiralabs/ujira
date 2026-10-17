// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The contract for conversions is documented at the top of convert.test.ts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InvalidScaleError,
  MoneyOverflowError,
  SETTLEMENT_TOKENS,
  convertMoney,
  convertToToken,
  moneyAt,
  rescale,
  tokenAmount,
  tokenToUsd,
  usdToToken,
} from './index.js';
import type { FiatCurrencyCode, RoundingMode } from './index.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'floor', 'ceil', 'trunc'];

// Fixed seed so a failure reproduces on every machine. Bump numRuns locally to
// search harder, never lower it to make a run pass.
const RUNS = { seed: 0xc0de19, numRuns: 1000 } as const;

// A thousand runs per property can take several times longer on a loaded
// runner, so the default 5 second timeout would fail them at random.
const PROPERTY_TIMEOUT_MS = 30_000;

const i128 = fc.oneof(
  fc.bigInt({ min: MIN, max: MAX }),
  fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
  fc.constantFrom(MIN, MIN + 1n, -1n, 0n, 1n, MAX - 1n, MAX),
);
const tokenArb = fc.constantFrom(...SETTLEMENT_TOKENS);
const fiatArb = fc.constantFrom<FiatCurrencyCode>('USD', 'NGN', 'KES', 'EUR', 'GBP');
const scaleArb = fc.integer({ min: 2, max: 18 });
const modeArb = fc.constantFrom(...MODES);

const inRange = (x: bigint): boolean => x >= MIN && x <= MAX;

function outcome<T>(run: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('conversion properties', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('tokenToUsd then usdToToken is the identity for every token amount', () => {
    fc.assert(
      fc.property(i128, tokenArb, (amount, t) => {
        const token = tokenAmount(amount, t.asset, t.chain);
        expect(usdToToken(tokenToUsd(token), t.asset, t.chain)).toEqual(token);
      }),
      RUNS,
    );
  });

  it('usdToToken then tokenToUsd returns the same dollars, rescaled exactly', () => {
    fc.assert(
      fc.property(i128, scaleArb, tokenArb, (amount, scale, t) => {
        const usd = moneyAt(amount, 'USD', scale);
        const r = outcome(() => usdToToken(usd, t.asset, t.chain));
        if (!r.ok) {
          // Only dropping a non-zero digit or leaving i128 may refuse.
          const err = r.error;
          if (scale > t.tokenScale) {
            expect(err).toBeInstanceOf(InvalidScaleError);
          } else {
            expect(err).toBeInstanceOf(MoneyOverflowError);
          }
          return;
        }
        expect(tokenToUsd(r.value)).toEqual(rescale(usd, t.tokenScale, 'trunc'));
      }),
      RUNS,
    );
  });

  it('convertMoney by a power of ten equals rescale with the same mode', () => {
    fc.assert(
      fc.property(
        i128,
        fiatArb,
        scaleArb,
        scaleArb,
        modeArb,
        (amount, currency, from, to, mode) => {
          const m = moneyAt(amount, currency, from);
          const rate =
            to >= from
              ? { numerator: 10n ** BigInt(to - from), denominator: 1n }
              : { numerator: 1n, denominator: 10n ** BigInt(from - to) };
          const viaRescale = outcome(() => rescale(m, to, mode));
          const viaRate = outcome(() => convertMoney(m, rate, { currency, scale: to }, mode));
          expect(viaRate.ok).toBe(viaRescale.ok);
          if (viaRate.ok && viaRescale.ok) expect(viaRate.value).toEqual(viaRescale.value);
        },
      ),
      RUNS,
    );
  });

  it('a rate of one keeps the amount, and rounding happens exactly once', () => {
    fc.assert(
      fc.property(
        i128,
        fiatArb,
        scaleArb,
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        modeArb,
        (amount, currency, scale, numerator, denominator, mode) => {
          const m = moneyAt(amount, currency, scale);
          const one = convertMoney(
            m,
            { numerator: 1n, denominator: 1n },
            { currency, scale },
            mode,
          );
          expect(one).toEqual(m);
          const r = outcome(() =>
            convertMoney(m, { numerator, denominator }, { currency, scale }, 'floor'),
          );
          if (!inRange(amount * numerator)) {
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.error).toBeInstanceOf(MoneyOverflowError);
            return;
          }
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          // floor(x / d) <= exact < floor(x / d) + 1
          const product = amount * numerator;
          expect(r.value.amount * denominator <= product).toBe(true);
          expect((r.value.amount + 1n) * denominator > product).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('convertToToken always lands at the target token decimals and chain', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
        tokenArb,
        tokenArb,
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        modeArb,
        (amount, from, to, numerator, denominator, mode) => {
          const source = tokenAmount(amount, from.asset, from.chain);
          const r = convertToToken(source, { numerator, denominator }, to, mode);
          expect(r.asset).toBe(to.asset);
          expect(r.chain).toBe(to.chain);
          expect(r.scale).toBe(to.tokenScale);
          expect(Object.isFrozen(r)).toBe(true);
        },
      ),
      RUNS,
    );
  });
});
