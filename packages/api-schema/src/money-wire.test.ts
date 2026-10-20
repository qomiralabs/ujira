// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { I128_MAX, money, moneyAt, tokenAmount } from '@ujira/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  Money,
  Rate,
  TokenAmount,
  WireFormatError,
  fromWireMoney,
  fromWireToken,
  toWireMoney,
  toWireToken,
  tokenSumEquals,
} from './index.js';

const usd = (amount: unknown, scale: unknown = 2): unknown => ({ amount, currency: 'USD', scale });
const usdc = (amount: unknown, scale: unknown = 7): unknown => ({
  amount,
  asset: 'USDC',
  network: 'stellar:testnet',
  scale,
});

describe('money on the wire', () => {
  it('a number amount, a decimal string and a scale mismatch are refused', () => {
    expect(Money.safeParse(usd(1250)).success).toBe(false);
    expect(Money.safeParse(usd(12.5)).success).toBe(false);
    expect(Money.safeParse(usd('12.50')).success).toBe(false);
    expect(Money.safeParse(usd('1250', 3)).success).toBe(false);
    expect(Money.safeParse(usd('1250', 0)).success).toBe(false);
    expect(TokenAmount.safeParse(usdc(125000000)).success).toBe(false);
    expect(TokenAmount.safeParse(usdc('12.5')).success).toBe(false);
    expect(TokenAmount.safeParse(usdc('125000000', 6)).success).toBe(false);
    // The well formed versions of the same values pass.
    expect(Money.safeParse(usd('1250')).success).toBe(true);
    expect(TokenAmount.safeParse(usdc('125000000')).success).toBe(true);
  });

  it('refuses signs, exponents, leading zeros, blanks and extra fields', () => {
    for (const amount of ['-1', '+1', '1e3', '01', '', ' 1', '1 ', '0x10', '\uFF11']) {
      expect(Money.safeParse(usd(amount)).success, amount).toBe(false);
    }
    expect(Money.safeParse({ amount: '1', currency: 'USD', scale: 2, note: 'x' }).success).toBe(
      false,
    );
    expect(Money.safeParse({ amount: '1', currency: 'USDC', scale: 2 }).success).toBe(false);
    expect(Money.safeParse({ amount: '1', currency: 'usd', scale: 2 }).success).toBe(false);
    expect(Money.safeParse(usd('1', 2.5)).success).toBe(false);
  });

  it('accepts zero and the i128 bound and refuses one past it', () => {
    expect(Money.safeParse(usd('0')).success).toBe(true);
    expect(Money.safeParse(usd(I128_MAX.toString())).success).toBe(true);
    expect(Money.safeParse(usd((I128_MAX + 1n).toString())).success).toBe(false);
    expect(TokenAmount.safeParse(usdc(I128_MAX.toString())).success).toBe(true);
    expect(TokenAmount.safeParse(usdc((I128_MAX + 1n).toString())).success).toBe(false);
    expect(Money.safeParse(usd('9'.repeat(40))).success).toBe(false);
  });

  it('refuses a token on a network it does not settle on', () => {
    expect(
      TokenAmount.safeParse({ amount: '1', asset: 'USDC', network: 'eip155:42220', scale: 7 })
        .success,
    ).toBe(false);
    expect(
      TokenAmount.safeParse({ amount: '1', asset: 'USDm', network: 'stellar:pubnet', scale: 7 })
        .success,
    ).toBe(false);
  });

  it('round trips through the core money model exactly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: I128_MAX }), (amount) => {
        const wire = toWireMoney(money(amount, 'NGN'));
        expect(Money.parse(wire)).toEqual(wire);
        expect(fromWireMoney(wire).amount).toBe(amount);
        const t = toWireToken(tokenAmount(amount, 'USDC', 'stellar'), 'stellar:pubnet');
        expect(TokenAmount.parse(t)).toEqual(t);
        expect(fromWireToken(t).amount).toBe(amount);
      }),
    );
  });

  it('will not send a value at a working scale', () => {
    expect(() => toWireMoney(moneyAt(1005n, 'USD', 3))).toThrow(WireFormatError);
  });

  it('checks token sums exactly and never throws on bad parts', () => {
    const a = usdc('3');
    const b = usdc('4');
    expect(tokenSumEquals([a, b], usdc('7'))).toBe(true);
    expect(tokenSumEquals([a, b], usdc('8'))).toBe(false);
    expect(tokenSumEquals([], usdc('0'))).toBe(false);
    expect(tokenSumEquals([a, { amount: 'x' }], usdc('7'))).toBe(false);
    expect(tokenSumEquals([a, b], { amount: 'x' })).toBe(false);
    expect(tokenSumEquals([usdc(I128_MAX.toString()), usdc('1')], usdc('0'))).toBe(false);
    const other = { amount: '4', asset: 'USDC', network: 'stellar:pubnet', scale: 7 };
    // Same token, different network: never one sum.
    expect(tokenSumEquals([a, other], usdc('7'))).toBe(false);
  });

  it('keeps rates as exact decimal text', () => {
    expect(Rate.safeParse({ rate: '1600.25', base: 'USDC', quote: 'NGN' }).success).toBe(true);
    expect(Rate.safeParse({ rate: 1600.25, base: 'USDC', quote: 'NGN' }).success).toBe(false);
    expect(Rate.safeParse({ rate: '0', base: 'USDC', quote: 'NGN' }).success).toBe(false);
    expect(Rate.safeParse({ rate: '1.6e3', base: 'USDC', quote: 'NGN' }).success).toBe(false);
    expect(Rate.safeParse({ rate: '1'.repeat(37), base: 'USD', quote: 'NGN' }).success).toBe(false);
    expect(Rate.safeParse({ rate: '1', base: 'USDC', quote: 'USDC' }).success).toBe(false);
  });
});
