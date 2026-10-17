// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the only ways a value changes unit (convert.ts, exported
 * from ./index.js and the package root).
 *
 * usdToToken(usd: Money, asset: TokenAsset, chain: Chain): TokenAmount
 *   Logical US dollars to a dollar token at par, at the token's decimals.
 *   Scaling up is exact. Scaling down is allowed only when no non-zero digit
 *   is dropped, otherwise InvalidScaleError; there is no rounding mode on
 *   purpose, because limits and budgets must never round. A non USD value
 *   throws CurrencyMismatchError, a token argument KindMismatchError and an
 *   unknown pair UnknownCurrencyError. Every settlement token is in
 *   DOLLAR_PEGGED.
 * tokenToUsd(t: TokenAmount): Money
 *   Back to US dollars at par, at the token's scale (exact). Fiat throws
 *   KindMismatchError.
 * type RateUnit = FiatCurrencyCode | TokenAsset
 * interface Rate {
 *   readonly base: RateUnit; readonly quote: RateUnit;
 *   readonly numerator: bigint; readonly denominator: bigint;
 * }
 *   numerator / denominator major units of the quote per major unit of the
 *   base, exactly as a rate is quoted: "1600.25" NGN per USD is base USD,
 *   quote NGN. A fiat amount's unit is its currency and a token amount's
 *   unit is its asset on any chain, so a USDC amount needs a USDC based rate,
 *   never a USD one. Scales never enter the rate; the conversion applies
 *   them. Both parts are bigints above zero and at most 36 digits each, else
 *   InvalidAmountError. A base or quote that is not a known fiat code or
 *   token asset throws UnknownCurrencyError.
 * parseRate(text: string, pair: { base: RateUnit; quote: RateUnit }): Rate
 *   A plain positive decimal of at most 36 digits ("1600.25" is 160025/100).
 *   No sign, exponent, separator or whitespace, never zero; anything else
 *   throws InvalidAmountError without echoing the text. The text is checked
 *   first, then the pair (a plain object, else UnknownCurrencyError). The
 *   result is frozen.
 * invertRate(rate: Rate): Rate
 *   The same rate read the other way: base and quote swap, and so do the
 *   numerator and denominator. Validated like any rate; the result is frozen.
 *   Inversion is never implicit: a conversion never flips a rate to fit.
 * convertMoney(from: Money | TokenAmount, rate: Rate,
 *              to: { currency: FiatCurrencyCode; scale?: number },
 *              rounding: RoundingMode): Money
 * convertToToken(from: Money | TokenAmount, rate: Rate,
 *                to: { asset: TokenAsset; chain: Chain },
 *                rounding: RoundingMode): TokenAmount
 *   With s the source scale and t the target scale (to.scale, default the
 *   minor unit, or the token's decimals):
 *     result = round(from.amount * numerator * 10^t / (denominator * 10^s))
 *   rounded once with the required mode. to.scale is validated as an
 *   integer from 0 to 18 before anything else uses it. Only the result is bounded to i128
 *   (MoneyOverflowError); bigint products have no intermediate overflow.
 *   Validation order: source, rate, target, then the pair, then rounding.
 *   The pair check throws RateMismatchError (code 'RATE_MISMATCH') when the
 *   source unit is not the rate's base or the target unit is not its quote.
 *   The rate and the target must be plain objects; their fields are read once.
 */

import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
import * as moneyIndex from './index.js';
import {
  CurrencyMismatchError,
  DOLLAR_PEGGED,
  InvalidAmountError,
  InvalidRoundingModeError,
  InvalidScaleError,
  KindMismatchError,
  MoneyError,
  MoneyOverflowError,
  RateMismatchError,
  SETTLEMENT_TOKENS,
  UnknownCurrencyError,
  convertMoney,
  convertToToken,
  invertRate,
  money,
  moneyAt,
  parseRate,
  tokenAmount,
  tokenToUsd,
  usdToToken,
} from './index.js';
import type { Rate, RateUnit } from './index.js';

const MAX = 2n ** 127n - 1n;

type ErrorClass = abstract new (message?: string) => MoneyError;

function loose(value: unknown): never {
  return value as never;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectMoneyError(run: () => unknown, Expected: ErrorClass): MoneyError {
  const err = thrown(run);
  expect(err).toBeInstanceOf(Expected);
  return err as MoneyError;
}

// Every rate in these tests names its pair, so a test can never lean on a
// rate that silently fits any pair.
function rateOf(text: string, base: RateUnit, quote: RateUnit): Rate {
  return parseRate(text, { base, quote });
}

function exact(base: RateUnit, quote: RateUnit, numerator: bigint, denominator: bigint): Rate {
  return { base, quote, numerator, denominator };
}

describe('exports', () => {
  it('exposes every conversion from the money index and the package root', () => {
    for (const name of [
      'usdToToken',
      'tokenToUsd',
      'parseRate',
      'invertRate',
      'convertMoney',
      'convertToToken',
    ]) {
      const fromIndex = (moneyIndex as Record<string, unknown>)[name];
      expect(fromIndex, name).toBeTypeOf('function');
      expect((root as Record<string, unknown>)[name], name).toBe(fromIndex);
    }
  });
});

describe('usdToToken', () => {
  it('scales logical dollars up exactly to each token', () => {
    expect(usdToToken(money(1230n, 'USD'), 'USDC', 'celo')).toEqual(
      tokenAmount(12_300_000n, 'USDC', 'celo'),
    );
    expect(usdToToken(money(1230n, 'USD'), 'USDC', 'stellar')).toEqual(
      tokenAmount(123_000_000n, 'USDC', 'stellar'),
    );
    expect(usdToToken(money(1230n, 'USD'), 'USDm', 'celo')).toEqual(
      tokenAmount(1230n * 10n ** 16n, 'USDm', 'celo'),
    );
  });

  it('keeps a limit at 10^-6 dollars exact on every chain', () => {
    const limit = moneyAt(1_234_567n, 'USD', 6);
    expect(usdToToken(limit, 'USDC', 'celo').amount).toBe(1_234_567n);
    expect(usdToToken(limit, 'USDC', 'stellar').amount).toBe(12_345_670n);
    expect(usdToToken(limit, 'USDm', 'celo').amount).toBe(1_234_567n * 10n ** 12n);
  });

  it('scales down only when no non-zero digit is dropped', () => {
    expect(usdToToken(moneyAt(1_230_000_000_000n, 'USD', 12), 'USDC', 'celo').amount).toBe(
      1_230_000n,
    );
    expectMoneyError(
      () => usdToToken(moneyAt(1_230_000_000_001n, 'USD', 12), 'USDC', 'celo'),
      InvalidScaleError,
    );
    expectMoneyError(
      () => usdToToken(moneyAt(-1n, 'USD', 18), 'USDC', 'stellar'),
      InvalidScaleError,
    );
  });

  it('bounds the result to i128', () => {
    expectMoneyError(() => usdToToken(money(MAX, 'USD'), 'USDC', 'celo'), MoneyOverflowError);
  });

  it('refuses another currency, a token argument and an unknown pair', () => {
    expectMoneyError(() => usdToToken(money(1n, 'EUR'), 'USDC', 'celo'), CurrencyMismatchError);
    expectMoneyError(
      () => usdToToken(loose(tokenAmount(1n, 'USDC', 'celo')), 'USDC', 'celo'),
      KindMismatchError,
    );
    expectMoneyError(
      () => usdToToken(money(1n, 'USD'), 'USDm', loose('stellar')),
      UnknownCurrencyError,
    );
  });

  it('only exists for dollar pegged tokens, which is every settlement token today', () => {
    for (const t of SETTLEMENT_TOKENS) expect(DOLLAR_PEGGED).toContain(t.asset);
  });
});

describe('tokenToUsd', () => {
  it('returns dollars at the token scale, exactly', () => {
    expect(tokenToUsd(tokenAmount(1_234_567n, 'USDC', 'celo'))).toEqual(
      moneyAt(1_234_567n, 'USD', 6),
    );
    expect(tokenToUsd(tokenAmount(-5n, 'USDm', 'celo'))).toEqual(moneyAt(-5n, 'USD', 18));
  });

  it('round trips with usdToToken for every token', () => {
    for (const t of SETTLEMENT_TOKENS) {
      const token = tokenAmount(987_654_321n, t.asset, t.chain);
      expect(usdToToken(tokenToUsd(token), t.asset, t.chain)).toEqual(token);
    }
  });

  it('refuses fiat money', () => {
    expectMoneyError(() => tokenToUsd(loose(money(1n, 'USD'))), KindMismatchError);
  });
});

describe('parseRate', () => {
  it.each([
    ['1600.25', 160_025n, 100n],
    ['1', 1n, 1n],
    ['0.5', 5n, 10n],
    ['0.000001', 1n, 1_000_000n],
    ['123456789012345678901234567890123456', 123456789012345678901234567890123456n, 1n],
    ['0.12345678901234567890123456789012345', 12345678901234567890123456789012345n, 10n ** 35n],
  ])('parses %s exactly', (text, numerator, denominator) => {
    const rate = rateOf(text, 'USD', 'NGN');
    expect(rate).toEqual({ base: 'USD', quote: 'NGN', numerator, denominator });
    expect(Object.isFrozen(rate)).toBe(true);
  });

  it.each([
    '0',
    '0.000',
    '-1',
    '+1',
    '1e3',
    '1,600.25',
    ' 1',
    '1.',
    '.5',
    '01',
    '',
    '1'.repeat(37),
    '1.' + '0'.repeat(35) + '1',
    '9'.repeat(1_000_000),
  ])('rejects %j', (text) => {
    expectMoneyError(() => rateOf(text, 'USD', 'NGN'), InvalidAmountError);
  });

  it('rejects non strings without calling toString', () => {
    const calls: string[] = [];
    const hostile = {
      toString() {
        calls.push('toString');
        return '1';
      },
    };
    for (const value of [1, 1n, null, undefined, hostile, Object('1')]) {
      expectMoneyError(
        () => parseRate(loose(value), { base: 'USD', quote: 'NGN' }),
        InvalidAmountError,
      );
    }
    expect(calls).toEqual([]);
    const err = expectMoneyError(() => rateOf('1\nlevel=info', 'USD', 'NGN'), InvalidAmountError);
    expect(err.message).not.toContain('level=info');
  });
});

describe('the worked example: a quoted rate in major units', () => {
  // 12.50 USDC at 1600.25 NGN per USDC is NGN 20,003.125, which rounds
  // half-even to 2,000,312 minor units on every chain and token.
  const rate = rateOf('1600.25', 'USDC', 'NGN');

  it.each([
    ['USDC on Stellar (7)', tokenAmount(125_000_000n, 'USDC', 'stellar'), rate],
    ['USDC on Celo (6)', tokenAmount(12_500_000n, 'USDC', 'celo'), rate],
    [
      'USDm on Celo (18)',
      tokenAmount(125n * 10n ** 17n, 'USDm', 'celo'),
      rateOf('1600.25', 'USDm', 'NGN'),
    ],
  ])('converts 12.50 %s to NGN 20,003.12', (_label, usdc, rate) => {
    expect(convertMoney(usdc, rate, { currency: 'NGN' }, 'half-even')).toEqual(
      money(2_000_312n, 'NGN'),
    );
    expect(convertMoney(usdc, rate, { currency: 'NGN', scale: 3 }, 'half-even')).toEqual(
      moneyAt(20_003_125n, 'NGN', 3),
    );
  });

  it('turns a rate pre-scaled by 10^n into a result exactly 10^n too large', () => {
    // Documents the misuse: rates are never multiplied by a power of ten.
    const usdc = tokenAmount(12_500_000n, 'USDC', 'celo');
    const right = convertMoney(usdc, rate, { currency: 'NGN', scale: 3 }, 'trunc');
    const prescaled = { ...rate, numerator: rate.numerator * 10n ** 4n };
    const wrong = convertMoney(usdc, prescaled, { currency: 'NGN', scale: 3 }, 'trunc');
    expect(wrong.amount).toBe(right.amount * 10n ** 4n);
  });
});

describe('convertMoney', () => {
  const ngnPerUsd = rateOf('1600.25', 'USD', 'NGN');

  it('converts at an exact rate and rounds once with the required mode', () => {
    // 12.30 USD at 1600.25 NGN per USD is 19683.075 NGN.
    const usd = money(1230n, 'USD');
    expect(convertMoney(usd, ngnPerUsd, { currency: 'NGN' }, 'half-even')).toEqual(
      money(1_968_308n, 'NGN'),
    );
    expect(convertMoney(usd, ngnPerUsd, { currency: 'NGN' }, 'floor')).toEqual(
      money(1_968_307n, 'NGN'),
    );
    // At a finer target scale the same value keeps more digits.
    expect(convertMoney(usd, ngnPerUsd, { currency: 'NGN', scale: 3 }, 'trunc')).toEqual(
      moneyAt(19_683_075n, 'NGN', 3),
    );
    expect(convertMoney(usd, ngnPerUsd, { currency: 'NGN', scale: 6 }, 'trunc')).toEqual(
      moneyAt(19_683_075_000n, 'NGN', 6),
    );
  });

  it('applies a quoted rate whatever the source and target scales', () => {
    // 1 of each token at 1600.25 NGN per token is 1600.25 NGN.
    for (const [amount, asset, chain] of [
      [1_000_000n, 'USDC', 'celo'],
      [10_000_000n, 'USDC', 'stellar'],
      [10n ** 18n, 'USDm', 'celo'],
    ] as const) {
      expect(
        convertMoney(
          tokenAmount(amount, asset, chain),
          rateOf('1600.25', asset, 'NGN'),
          { currency: 'NGN' },
          'trunc',
        ),
      ).toEqual(money(160_025n, 'NGN'));
    }
    // A rate of 1 between dollar units at different scales keeps the value.
    const usdPerUsd = rateOf('1', 'USD', 'USD');
    expect(
      convertMoney(money(100n, 'USD'), usdPerUsd, { currency: 'USD', scale: 6 }, 'trunc'),
    ).toEqual(moneyAt(1_000_000n, 'USD', 6));
    expect(
      convertMoney(moneyAt(1_000_000n, 'USD', 6), usdPerUsd, { currency: 'USD' }, 'trunc'),
    ).toEqual(money(100n, 'USD'));
  });

  it('converts a token amount to fiat', () => {
    // 1.234567 USDC at 1600.25 NGN per USDC is 1975.61584175 NGN, so
    // half-up to cents gives 197562.
    expect(
      convertMoney(
        tokenAmount(1_234_567n, 'USDC', 'celo'),
        rateOf('1600.25', 'USDC', 'NGN'),
        { currency: 'NGN' },
        'half-up',
      ),
    ).toEqual(money(197_562n, 'NGN'));
  });

  it('bounds only the result to i128', () => {
    // The largest rate part, 36 digits, times an amount near the bound.
    const big = exact('USD', 'USD', 10n ** 36n - 1n, 1n);
    expectMoneyError(
      () => convertMoney(money(1000n, 'USD'), big, { currency: 'USD' }, 'trunc'),
      MoneyOverflowError,
    );
    expect(convertMoney(money(1n, 'USD'), big, { currency: 'USD' }, 'trunc').amount).toBe(
      10n ** 36n - 1n,
    );
    // The product passes i128 on the way, but the result fits.
    const wide = exact('USD', 'USD', 10n ** 20n, 10n ** 20n);
    expect(convertMoney(money(10n ** 20n, 'USD'), wide, { currency: 'USD' }, 'trunc')).toEqual(
      money(10n ** 20n, 'USD'),
    );
    expect(
      convertMoney(
        tokenAmount(MAX, 'USDm', 'celo'),
        rateOf('1', 'USDm', 'USD'),
        { currency: 'USD' },
        'trunc',
      ),
    ).toEqual(money(MAX / 10n ** 16n, 'USD'));
  });

  it('validates the source, then the rate, then the target, then the pair, then the rounding', () => {
    const forged = loose({ kind: 'fiat', amount: 1, currency: 'USD', scale: 2 });
    expectMoneyError(
      () => convertMoney(forged, loose(null), loose(null), loose('x')),
      InvalidAmountError,
    );
    expectMoneyError(
      () =>
        convertMoney(
          money(1n, 'USD'),
          loose({ base: 'USD', quote: 'NGN', numerator: 0n, denominator: 1n }),
          loose(null),
          loose('x'),
        ),
      InvalidAmountError,
    );
    expectMoneyError(
      () =>
        convertMoney(
          money(1n, 'USD'),
          loose({ base: 'XXX', quote: 'NGN', numerator: 1n, denominator: 1n }),
          loose(null),
          loose('x'),
        ),
      UnknownCurrencyError,
    );
    expectMoneyError(
      () => convertMoney(money(1n, 'USD'), ngnPerUsd, loose({ currency: 'USDC' }), loose('x')),
      UnknownCurrencyError,
    );
    expectMoneyError(
      () => convertMoney(money(1n, 'USD'), ngnPerUsd, { currency: 'NGN', scale: 1 }, loose('x')),
      InvalidScaleError,
    );
    expectMoneyError(
      () => convertMoney(money(1n, 'KES'), ngnPerUsd, { currency: 'NGN' }, loose(undefined)),
      RateMismatchError,
    );
    expectMoneyError(
      () => convertMoney(money(1n, 'USD'), ngnPerUsd, { currency: 'NGN' }, loose(undefined)),
      InvalidRoundingModeError,
    );
  });

  it.each([
    ['a zero numerator', { base: 'USD', quote: 'NGN', numerator: 0n, denominator: 1n }],
    ['a negative denominator', { base: 'USD', quote: 'NGN', numerator: 1n, denominator: -1n }],
    ['a number part', { base: 'USD', quote: 'NGN', numerator: 1, denominator: 1n }],
    ['a part past i128', { base: 'USD', quote: 'NGN', numerator: MAX + 1n, denominator: 1n }],
    [
      'a numerator of 37 digits',
      { base: 'USD', quote: 'NGN', numerator: 10n ** 36n, denominator: 1n },
    ],
    [
      'a denominator of 37 digits',
      { base: 'USD', quote: 'NGN', numerator: 1n, denominator: 10n ** 36n },
    ],
    ['a missing part', { base: 'USD', quote: 'NGN', numerator: 1n }],
    [
      'a non plain object',
      Object.create({ base: 'USD', quote: 'NGN', numerator: 1n, denominator: 1n }) as unknown,
    ],
    ['null', null],
  ])('rejects a rate with %s', (_label, rate) => {
    expectMoneyError(
      () => convertMoney(money(1n, 'USD'), loose(rate), { currency: 'NGN' }, 'trunc'),
      InvalidAmountError,
    );
  });

  it('rejects a target that is not a plain object naming a fiat currency', () => {
    for (const to of [null, 'NGN', Object.create({ currency: 'NGN' }) as unknown, {}]) {
      expectMoneyError(
        () => convertMoney(money(1n, 'USD'), ngnPerUsd, loose(to), 'trunc'),
        UnknownCurrencyError,
      );
    }
  });
});

describe('convertToToken', () => {
  it('converts fiat to a token at its decimals with the required mode', () => {
    // 1 USDC per 1600.25 NGN is 100 / 160025 USDC per NGN.
    const rate = exact('NGN', 'USDC', 100n, 160_025n);
    const r = convertToToken(
      money(160_025n, 'NGN'),
      rate,
      { asset: 'USDC', chain: 'celo' },
      'trunc',
    );
    expect(r).toEqual(tokenAmount(1_000_000n, 'USDC', 'celo'));
    // 0.01 NGN is 62.49... Stellar USDC units, so ceil gives 63.
    expect(
      convertToToken(money(1n, 'NGN'), rate, { asset: 'USDC', chain: 'stellar' }, 'ceil'),
    ).toEqual(tokenAmount(63n, 'USDC', 'stellar'));
    // A quoted rate below one, as a quote would print it.
    expect(
      convertToToken(
        money(160_025n, 'NGN'),
        rateOf('0.000624902', 'NGN', 'USDC'),
        { asset: 'USDC', chain: 'celo' },
        'trunc',
      ),
    ).toEqual(tokenAmount(999_999n, 'USDC', 'celo'));
  });

  it('moves a token between chains only through an explicit rate', () => {
    const celo = tokenAmount(1_234_567n, 'USDC', 'celo');
    const toStellar = rateOf('1', 'USDC', 'USDC');
    expect(convertToToken(celo, toStellar, { asset: 'USDC', chain: 'stellar' }, 'trunc')).toEqual(
      tokenAmount(12_345_670n, 'USDC', 'stellar'),
    );
  });

  it('rejects an unknown pair and a missing rounding mode', () => {
    const one = exact('USD', 'USDC', 1n, 1n);
    expectMoneyError(
      () =>
        convertToToken(money(1n, 'USD'), one, loose({ asset: 'USDm', chain: 'stellar' }), 'trunc'),
      UnknownCurrencyError,
    );
    expectMoneyError(
      () => convertToToken(money(1n, 'USD'), one, { asset: 'USDC', chain: 'celo' }, loose('up')),
      InvalidRoundingModeError,
    );
  });
});

describe('quoted rates against a bigint reference', () => {
  type Unit =
    | { kind: 'fiat'; scale: number }
    | { kind: 'token'; asset: 'USDC' | 'USDm'; chain: 'celo' | 'stellar'; scale: number };
  const units: Unit[] = [
    { kind: 'fiat', scale: 2 },
    { kind: 'fiat', scale: 6 },
    { kind: 'fiat', scale: 18 },
    { kind: 'token', asset: 'USDC', chain: 'celo', scale: 6 },
    { kind: 'token', asset: 'USDC', chain: 'stellar', scale: 7 },
    { kind: 'token', asset: 'USDm', chain: 'celo', scale: 18 },
  ];
  const source = (unit: Unit, amount: bigint) =>
    unit.kind === 'fiat'
      ? moneyAt(amount, 'USD', unit.scale)
      : tokenAmount(amount, unit.asset, unit.chain);
  const unitOf = (unit: Unit): RateUnit => (unit.kind === 'fiat' ? 'USD' : unit.asset);

  // Truncating reference: amount * n * 10^t / (d * 10^s), written out on its own.
  const reference = (amount: bigint, n: bigint, d: bigint, s: number, t: number): bigint =>
    (amount * n * 10n ** BigInt(t)) / (d * 10n ** BigInt(s));

  for (const text of ['1600.25', '0.000624902', '1', '3.5']) {
    for (const from of units) {
      for (const to of units) {
        const rate = rateOf(text, unitOf(from), to.kind === 'fiat' ? 'NGN' : to.asset);
        it(`converts at ${text} from ${from.kind} scale ${String(from.scale)} to ${to.kind} scale ${String(to.scale)}`, () => {
          const amount = 123_456_789n;
          const want = reference(amount, rate.numerator, rate.denominator, from.scale, to.scale);
          const got =
            to.kind === 'fiat'
              ? convertMoney(
                  source(from, amount),
                  rate,
                  { currency: 'NGN', scale: to.scale },
                  'trunc',
                )
              : convertToToken(
                  source(from, amount),
                  rate,
                  { asset: to.asset, chain: to.chain },
                  'trunc',
                );
          expect(got.amount).toBe(want);
          expect(got.scale).toBe(to.scale);
        });
      }
    }
  }
});

describe('rates bound to their base and quote', () => {
  const ngnPerUsd = rateOf('1600.25', 'USD', 'NGN');
  const usdPerNgn = invertRate(ngnPerUsd);

  it('refuses an NGN per USD rate for a KES target', () => {
    const err = expectMoneyError(
      () => convertMoney(money(100n, 'USD'), ngnPerUsd, { currency: 'KES' }, 'trunc'),
      RateMismatchError,
    );
    expect(err.code).toBe('RATE_MISMATCH');
    expect(err.name).toBe('RateMismatchError');
    expect(err).toBeInstanceOf(MoneyError);
  });

  it('refuses a USD per NGN rate for a USD amount', () => {
    expectMoneyError(
      () => convertMoney(money(100n, 'USD'), usdPerNgn, { currency: 'USD' }, 'trunc'),
      RateMismatchError,
    );
  });

  it('refuses a rate for another source, without flipping it to fit', () => {
    // An NGN amount needs the inverse of an NGN per USD rate, and a
    // conversion never inverts on its own.
    expectMoneyError(
      () => convertMoney(money(100n, 'NGN'), ngnPerUsd, { currency: 'USD' }, 'trunc'),
      RateMismatchError,
    );
    expectMoneyError(
      () => convertMoney(money(100n, 'KES'), ngnPerUsd, { currency: 'NGN' }, 'trunc'),
      RateMismatchError,
    );
  });

  it('treats a token as its asset, never as the dollar it tracks', () => {
    const usdc = tokenAmount(1_000_000n, 'USDC', 'celo');
    expectMoneyError(
      () => convertMoney(usdc, ngnPerUsd, { currency: 'NGN' }, 'trunc'),
      RateMismatchError,
    );
    expectMoneyError(
      () =>
        convertMoney(
          tokenAmount(10n ** 18n, 'USDm', 'celo'),
          rateOf('1600.25', 'USDC', 'NGN'),
          { currency: 'NGN' },
          'trunc',
        ),
      RateMismatchError,
    );
    // One asset on two chains shares a rate.
    const usdcRate = rateOf('1600.25', 'USDC', 'NGN');
    expect(convertMoney(usdc, usdcRate, { currency: 'NGN' }, 'trunc')).toEqual(
      convertMoney(
        tokenAmount(10_000_000n, 'USDC', 'stellar'),
        usdcRate,
        { currency: 'NGN' },
        'trunc',
      ),
    );
  });

  it('checks the token target against the quote', () => {
    const usdcPerNgn = exact('NGN', 'USDC', 100n, 160_025n);
    expectMoneyError(
      () =>
        convertToToken(
          money(160_025n, 'NGN'),
          usdcPerNgn,
          { asset: 'USDm', chain: 'celo' },
          'trunc',
        ),
      RateMismatchError,
    );
    expectMoneyError(
      () =>
        convertToToken(
          money(160_025n, 'KES'),
          usdcPerNgn,
          { asset: 'USDC', chain: 'celo' },
          'trunc',
        ),
      RateMismatchError,
    );
    expectMoneyError(
      () => convertToToken(money(1n, 'NGN'), ngnPerUsd, { asset: 'USDC', chain: 'celo' }, 'trunc'),
      RateMismatchError,
    );
  });

  it('keeps mismatch messages free of the rate and amount', () => {
    const err = expectMoneyError(
      () => convertMoney(money(123_456n, 'USD'), ngnPerUsd, { currency: 'KES' }, 'trunc'),
      RateMismatchError,
    );
    expect(err.message).not.toMatch(/1600|160025|123456/);
  });

  it('inverts explicitly, swapping base, quote and the two parts', () => {
    expect(usdPerNgn).toEqual({
      base: 'NGN',
      quote: 'USD',
      numerator: 100n,
      denominator: 160_025n,
    });
    expect(Object.isFrozen(usdPerNgn)).toBe(true);
    expect(invertRate(usdPerNgn)).toEqual(ngnPerUsd);
    // 1600.25 NGN back to dollars at the inverted rate is exactly one dollar.
    expect(convertMoney(money(160_025n, 'NGN'), usdPerNgn, { currency: 'USD' }, 'trunc')).toEqual(
      money(100n, 'USD'),
    );
  });

  it('validates the rate it inverts', () => {
    expectMoneyError(
      () => invertRate(loose({ base: 'USD', quote: 'NGN', numerator: 0n, denominator: 1n })),
      InvalidAmountError,
    );
    expectMoneyError(
      () => invertRate(loose({ base: 'USD', quote: 'XXX', numerator: 1n, denominator: 1n })),
      UnknownCurrencyError,
    );
    expectMoneyError(() => invertRate(loose(null)), InvalidAmountError);
  });

  it('parses the pair after the text and refuses an unknown unit', () => {
    expect(rateOf('2', 'USDm', 'KES')).toEqual(exact('USDm', 'KES', 2n, 1n));
    for (const pair of [
      { base: 'XXX', quote: 'NGN' },
      { base: 'USD', quote: 'usd' },
      { base: 'USD' },
      { base: 'constructor', quote: 'NGN' },
      null,
      'USD/NGN',
      Object.create({ base: 'USD', quote: 'NGN' }) as unknown,
    ]) {
      expectMoneyError(() => parseRate('1', loose(pair)), UnknownCurrencyError);
    }
    // A bad text is reported first even when the pair is bad too.
    expectMoneyError(() => parseRate('0', loose(null)), InvalidAmountError);
  });

  it('refuses a rate with an unknown or missing unit at conversion time', () => {
    for (const rate of [
      { base: 'XXX', quote: 'NGN', numerator: 1n, denominator: 1n },
      { quote: 'NGN', numerator: 1n, denominator: 1n },
      { base: 'USD', quote: 7, numerator: 1n, denominator: 1n },
    ]) {
      expectMoneyError(
        () => convertMoney(money(1n, 'USD'), loose(rate), { currency: 'NGN' }, 'trunc'),
        UnknownCurrencyError,
      );
    }
  });
});
