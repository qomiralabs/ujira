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
  invertRate,
  moneyAt,
  parseRate,
  rescale,
  tokenAmount,
  tokenToUsd,
  usdToToken,
} from './index.js';
import type { FiatCurrencyCode, Rate, RateUnit, RoundingMode } from './index.js';

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

/** A decimal as a quote prints it: `digits` with `places` after the point. */
function decimal(digits: bigint, places: number): string {
  const text = digits.toString().padStart(places + 1, '0');
  return places === 0 ? text : `${text.slice(0, -places)}.${text.slice(-places)}`;
}

// Only rates issued by parseRate or invertRate convert, so a random rate is
// a random quoted decimal, read one way or the other.
const rateSpec = (maxDigits: bigint, maxPlaces: number) =>
  fc.record({
    digits: fc.bigInt({ min: 1n, max: maxDigits }),
    places: fc.integer({ min: 0, max: maxPlaces }),
    inverted: fc.boolean(),
  });
const rateSpecArb = rateSpec(10n ** 9n, 9);

function rateFrom(
  spec: { digits: bigint; places: number; inverted: boolean },
  base: RateUnit,
  quote: RateUnit,
): Rate {
  const text = decimal(spec.digits, spec.places);
  return spec.inverted
    ? invertRate(parseRate(text, { base: quote, quote: base }))
    : parseRate(text, { base, quote });
}

const unitRate = (unit: RateUnit): Rate => parseRate('1', { base: unit, quote: unit });

/** Independent rounding reference: n / d (d > 0) to an integer with a mode. */
function roundReference(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const q = n / d;
  if (n - q * d === 0n) return q;
  const down = n < 0n ? q - 1n : q;
  const up = down + 1n;
  if (mode === 'floor') return down;
  if (mode === 'ceil') return up;
  if (mode === 'trunc') return q;
  const twice = 2n * (n - down * d);
  if (twice !== d) return twice < d ? down : up;
  if (mode === 'half-up') return n < 0n ? down : up;
  return down % 2n === 0n ? down : up;
}

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

  it('convertMoney at a rate of one equals rescale with the same mode', () => {
    fc.assert(
      fc.property(
        i128,
        fiatArb,
        scaleArb,
        scaleArb,
        modeArb,
        (amount, currency, from, to, mode) => {
          const m = moneyAt(amount, currency, from);
          const one = unitRate(currency);
          const viaRescale = outcome(() => rescale(m, to, mode));
          const viaRate = outcome(() => convertMoney(m, one, { currency, scale: to }, mode));
          expect(viaRate.ok).toBe(viaRescale.ok);
          if (viaRate.ok && viaRescale.ok) expect(viaRate.value).toEqual(viaRescale.value);
        },
      ),
      RUNS,
    );
  });

  it('the same major unit value converts identically whatever scale it is held at', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 0, max: 8 }),
        rateSpecArb,
        scaleArb,
        modeArb,
        (amount, low, extra, spec, to, mode) => {
          const rate = rateFrom(spec, 'USD', 'NGN');
          const coarse = moneyAt(amount, 'USD', low);
          const fine = moneyAt(amount * 10n ** BigInt(extra), 'USD', low + extra);
          // Both refuse or both give the same value; large rates can overflow.
          const a = outcome(() => convertMoney(coarse, rate, { currency: 'NGN', scale: to }, mode));
          const b = outcome(() => convertMoney(fine, rate, { currency: 'NGN', scale: to }, mode));
          expect(b.ok).toBe(a.ok);
          if (a.ok && b.ok) expect(b.value).toEqual(a.value);
        },
      ),
      RUNS,
    );
  });

  it('every token holding the same dollars converts identically', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        rateSpecArb,
        scaleArb,
        modeArb,
        (micros, spec, to, mode) => {
          // micros is the value in millionths of a dollar, exact on every token.
          const results = SETTLEMENT_TOKENS.map((t) =>
            outcome(() =>
              convertMoney(
                tokenAmount(micros * 10n ** BigInt(t.tokenScale - 6), t.asset, t.chain),
                rateFrom(spec, t.asset, 'NGN'),
                { currency: 'NGN', scale: to },
                mode,
              ),
            ),
          );
          for (const r of results) {
            expect(r.ok).toBe(results[0]?.ok);
            if (r.ok && results[0]?.ok) expect(r.value).toEqual(results[0].value);
          }
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
        rateSpecArb,
        modeArb,
        (amount, currency, scale, spec, mode) => {
          const m = moneyAt(amount, currency, scale);
          const one = convertMoney(m, unitRate(currency), { currency, scale }, mode);
          expect(one).toEqual(m);
          // A unit only converts to itself at 1, so the priced leg goes to
          // another currency with the same minor unit.
          const other = currency === 'NGN' ? 'KES' : 'NGN';
          const rate = rateFrom(spec, currency, other);
          const { numerator, denominator } = rate;
          const r = outcome(() => convertMoney(m, rate, { currency: other, scale }, 'floor'));
          // Only the result is bounded, never the product on the way.
          if (!inRange(roundReference(amount * numerator, denominator, 'floor'))) {
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

  it('a quoted rate matches an exact rational reference for every unit and mode', () => {
    // Rates as a quote prints them, from tiny to large.
    const rateText = fc
      .tuple(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.integer({ min: 0, max: 12 }))
      .map(([digits, places]) => decimal(digits, places));
    const unitArb = fc.oneof(
      fc.integer({ min: 2, max: 18 }).map((scale) => ({ kind: 'fiat' as const, scale })),
      tokenArb.map((t) => ({
        kind: 'token' as const,
        asset: t.asset,
        chain: t.chain,
        scale: t.tokenScale,
      })),
    );
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }),
        rateText,
        unitArb,
        unitArb,
        modeArb,
        (amount, quoted, from, to, mode) => {
          const base = from.kind === 'fiat' ? 'USD' : from.asset;
          const quote = to.kind === 'fiat' ? 'EUR' : to.asset;
          // A token to itself only moves at 1.
          const text = base === quote ? '1' : quoted;
          // The reference reads the rate straight from its text.
          const [whole = '', fraction = ''] = text.split('.');
          const n = BigInt(whole + fraction);
          const d = 10n ** BigInt(fraction.length);
          const want = roundReference(
            amount * n * 10n ** BigInt(to.scale),
            d * 10n ** BigInt(from.scale),
            mode,
          );
          const src =
            from.kind === 'fiat'
              ? moneyAt(amount, 'USD', from.scale)
              : tokenAmount(amount, from.asset, from.chain);
          const rate = parseRate(text, { base, quote });
          const r = outcome(() =>
            to.kind === 'fiat'
              ? convertMoney(src, rate, { currency: 'EUR', scale: to.scale }, mode)
              : convertToToken(src, rate, { asset: to.asset, chain: to.chain }, mode),
          );
          if (!inRange(want)) {
            expect(r.ok).toBe(false);
            return;
          }
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.value.amount).toBe(want);
        },
      ),
      RUNS,
    );
  });

  it('convertToToken always lands at the target token decimals and chain', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
        fiatArb,
        // Small enough that every result fits, as the property is about
        // where the result lands, not about overflow.
        rateSpec(10n ** 6n, 6),
        tokenArb,
        modeArb,
        (amount, currency, spec, to, mode) => {
          const source = moneyAt(amount, currency, 2);
          const rate = rateFrom(spec, currency, to.asset);
          const r = convertToToken(source, rate, to, mode);
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
