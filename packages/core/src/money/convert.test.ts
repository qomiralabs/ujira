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
 * interface Rate { readonly numerator: bigint; readonly denominator: bigint }
 *   Target units per source unit, each at the scale its value is held at.
 *   Both parts are bigints above zero and within i128, else InvalidAmountError.
 * parseRate(text: string): Rate
 *   A plain positive decimal of at most 36 digits ("1600.25" is 160025/100).
 *   No sign, exponent, separator or whitespace, never zero; anything else
 *   throws InvalidAmountError without echoing the text. The result is frozen.
 * convertMoney(from: Money | TokenAmount, rate: Rate,
 *              to: { currency: FiatCurrencyCode; scale?: number },
 *              rounding: RoundingMode): Money
 * convertToToken(from: Money | TokenAmount, rate: Rate,
 *                to: { asset: TokenAsset; chain: Chain },
 *                rounding: RoundingMode): TokenAmount
 *   result = round(from.amount * numerator / denominator) with the required
 *   rounding mode, at to.scale (default the minor unit) or the token's
 *   decimals. The product and the result are both bounded to i128
 *   (MoneyOverflowError). Validation order: source, rate, target, rounding.
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
  MoneyOverflowError,
  SETTLEMENT_TOKENS,
  UnknownCurrencyError,
  convertMoney,
  convertToToken,
  money,
  moneyAt,
  parseRate,
  tokenAmount,
  tokenToUsd,
  usdToToken,
} from './index.js';
import type { Rate, MoneyError } from './index.js';

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

describe('exports', () => {
  it('exposes every conversion from the money index and the package root', () => {
    for (const name of [
      'usdToToken',
      'tokenToUsd',
      'parseRate',
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
    const rate = parseRate(text);
    expect(rate).toEqual({ numerator, denominator });
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
    expectMoneyError(() => parseRate(text), InvalidAmountError);
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
      expectMoneyError(() => parseRate(loose(value)), InvalidAmountError);
    }
    expect(calls).toEqual([]);
    const err = expectMoneyError(() => parseRate('1\nlevel=info'), InvalidAmountError);
    expect(err.message).not.toContain('level=info');
  });
});

describe('convertMoney', () => {
  const ngnPerUsd = parseRate('1600.25');

  it('converts at an exact rate and rounds once with the required mode', () => {
    // 12.30 USD at 1600.25 NGN per USD is 19683.075 NGN.
    const usd = money(1230n, 'USD');
    expect(convertMoney(usd, ngnPerUsd, { currency: 'NGN' }, 'half-even')).toEqual(
      money(1_968_308n, 'NGN'),
    );
    expect(convertMoney(usd, ngnPerUsd, { currency: 'NGN' }, 'floor')).toEqual(
      money(1_968_307n, 'NGN'),
    );
    expect(convertMoney(usd, ngnPerUsd, { currency: 'NGN', scale: 3 }, 'trunc')).toEqual(
      moneyAt(1_968_307n, 'NGN', 3),
    );
  });

  it('converts a token amount to fiat', () => {
    // 1.234567 USDC on Celo to NGN cents, the rate in NGN cents per USDC
    // unit: 1234567 * 160025 / 10^6 is 197561.584175, so half-up gives 197562.
    const rate: Rate = { numerator: 160_025n, denominator: 1_000_000n };
    expect(
      convertMoney(tokenAmount(1_234_567n, 'USDC', 'celo'), rate, { currency: 'NGN' }, 'half-up'),
    ).toEqual(money(197_562n, 'NGN'));
  });

  it('bounds the product and the result to i128', () => {
    const big: Rate = { numerator: MAX, denominator: 1n };
    expectMoneyError(
      () => convertMoney(money(2n, 'USD'), big, { currency: 'USD' }, 'trunc'),
      MoneyOverflowError,
    );
    expect(convertMoney(money(1n, 'USD'), big, { currency: 'USD' }, 'trunc').amount).toBe(MAX);
  });

  it('validates the source, then the rate, then the target, then the rounding', () => {
    const forged = loose({ kind: 'fiat', amount: 1, currency: 'USD', scale: 2 });
    expectMoneyError(
      () => convertMoney(forged, loose(null), loose(null), loose('x')),
      InvalidAmountError,
    );
    expectMoneyError(
      () =>
        convertMoney(
          money(1n, 'USD'),
          loose({ numerator: 0n, denominator: 1n }),
          loose(null),
          loose('x'),
        ),
      InvalidAmountError,
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
      () => convertMoney(money(1n, 'USD'), ngnPerUsd, { currency: 'NGN' }, loose(undefined)),
      InvalidRoundingModeError,
    );
  });

  it.each([
    ['a zero numerator', { numerator: 0n, denominator: 1n }],
    ['a negative denominator', { numerator: 1n, denominator: -1n }],
    ['a number part', { numerator: 1, denominator: 1n }],
    ['a part past i128', { numerator: MAX + 1n, denominator: 1n }],
    ['a missing part', { numerator: 1n }],
    ['a non plain object', Object.create({ numerator: 1n, denominator: 1n }) as unknown],
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
    // 1600.25 NGN to USDC on Celo at 1 USDC per 1600.25 NGN:
    // NGN cents to USDC units is 10^6 / 160025.
    const rate: Rate = { numerator: 1_000_000n, denominator: 160_025n };
    const r = convertToToken(
      money(160_025n, 'NGN'),
      rate,
      { asset: 'USDC', chain: 'celo' },
      'trunc',
    );
    expect(r).toEqual(tokenAmount(1_000_000n, 'USDC', 'celo'));
    expect(
      convertToToken(money(1n, 'NGN'), rate, { asset: 'USDC', chain: 'stellar' }, 'ceil'),
    ).toEqual(tokenAmount(7n, 'USDC', 'stellar'));
  });

  it('moves a token between chains only through an explicit rate', () => {
    const celo = tokenAmount(1_234_567n, 'USDC', 'celo');
    const toStellar: Rate = { numerator: 10n, denominator: 1n };
    expect(convertToToken(celo, toStellar, { asset: 'USDC', chain: 'stellar' }, 'trunc')).toEqual(
      tokenAmount(12_345_670n, 'USDC', 'stellar'),
    );
  });

  it('rejects an unknown pair and a missing rounding mode', () => {
    const one: Rate = { numerator: 1n, denominator: 1n };
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
