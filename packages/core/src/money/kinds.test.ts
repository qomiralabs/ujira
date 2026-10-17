// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fiat money and token amounts are separate types. Each case below is
// checked twice: the @ts-expect-error line fails typecheck if the compiler
// ever accepts the mix, and the runtime assertion proves the kind check
// still catches values that slip past the compiler (decoded rows, casts).

import { describe, expect, it } from 'vitest';

import {
  InvalidScaleError,
  KindMismatchError,
  TokenMismatchError,
  UnknownCurrencyError,
  add,
  allocate,
  compare,
  convertMoney,
  formatMoney,
  formatTokenAmount,
  money,
  moneyAt,
  rescale,
  sum,
  toMinor,
  tokenAmount,
  tokenToUsd,
  usdToToken,
} from './index.js';
import type { Money, TokenAmount } from './index.js';

const usd: Money = money(1230n, 'USD');
const celo: TokenAmount = tokenAmount(1_230_000n, 'USDC', 'celo');
const stellar: TokenAmount = tokenAmount(12_300_000n, 'USDC', 'stellar');

describe('the compiler and the runtime keep the kinds apart', () => {
  it('refuses to combine fiat and a token', () => {
    // @ts-expect-error fiat and token amounts never add
    expect(() => add(usd, celo)).toThrow(KindMismatchError);
    // @ts-expect-error fiat and token amounts never compare
    expect(() => compare(celo, usd)).toThrow(KindMismatchError);
    // @ts-expect-error a list holds one kind
    expect(() => sum([usd, celo])).toThrow(KindMismatchError);
  });

  it('refuses tokens where only fiat makes sense', () => {
    // @ts-expect-error formatMoney takes fiat only
    expect(() => formatMoney(celo, { locale: 'en-US' })).toThrow(KindMismatchError);
    // @ts-expect-error a token never changes scale
    expect(() => rescale(celo, 7, 'trunc')).toThrow(KindMismatchError);
    // @ts-expect-error toMinor is for fiat working scales
    expect(() => toMinor(celo, 'trunc')).toThrow(KindMismatchError);
    // @ts-expect-error usdToToken converts dollars, not tokens
    expect(() => usdToToken(celo, 'USDC', 'stellar')).toThrow(KindMismatchError);
  });

  it('refuses fiat where only tokens make sense', () => {
    // @ts-expect-error formatTokenAmount takes tokens only
    expect(() => formatTokenAmount(usd, { locale: 'en-US' })).toThrow(KindMismatchError);
    // @ts-expect-error tokenToUsd converts tokens
    expect(() => tokenToUsd(usd)).toThrow(KindMismatchError);
  });

  it('refuses a scale for a token and a token code for fiat', () => {
    // @ts-expect-error a token takes its scale from the table, never an argument
    expect(() => tokenAmount(1n, 'USDC', 'celo', 9)).toThrow(InvalidScaleError);
    // @ts-expect-error a token asset is not a fiat currency
    expect(() => moneyAt(1n, 'USDC', 6)).toThrow(UnknownCurrencyError);
  });

  it('keeps one asset on two chains as two values', () => {
    expect(() => add(celo, stellar)).toThrow(TokenMismatchError);
    const legs: TokenAmount[] = allocate(celo, [1n, 1n]);
    expect(legs.every((leg) => leg.chain === 'celo')).toBe(true);
  });

  it('lets a priced conversion take either kind as its source', () => {
    const one = { numerator: 1n, denominator: 1n };
    const fromToken: Money = convertMoney(celo, one, { currency: 'USD', scale: 6 }, 'trunc');
    const fromFiat: Money = convertMoney(usd, one, { currency: 'USD' }, 'trunc');
    expect(fromToken).toEqual(moneyAt(1_230_000n, 'USD', 6));
    expect(fromFiat).toEqual(usd);
  });
});
