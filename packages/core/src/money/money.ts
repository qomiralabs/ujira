// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { isCurrencyCode } from './currencies.js';
import type { CurrencyCode } from './currencies.js';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  InvalidScaleError,
  MoneyOverflowError,
  ScaleMismatchError,
  UnknownCurrencyError,
} from './errors.js';

// Soroban stores amounts as i128, so anything wider could never settle there.
export const I128_MIN: bigint = -(2n ** 127n);
export const I128_MAX: bigint = 2n ** 127n - 1n;

// USDm on Celo uses 18 decimals, the widest token we settle.
export const MAX_SCALE = 18;

/** An amount in minor units at `scale`. Build it with `money`, never by hand. */
export interface Money {
  readonly amount: bigint;
  readonly currency: CurrencyCode;
  readonly scale: number;
}

const CANONICAL_INTEGER = /^-?(0|[1-9][0-9]*)$/;

// I128_MIN has 39 digits. Longer strings are rejected before BigInt parses
// them, so a hostile megabyte of nines costs nothing.
const MAX_I128_DIGITS = 39;

function inRange(value: bigint): boolean {
  return value >= I128_MIN && value <= I128_MAX;
}

function checked(value: bigint): bigint {
  if (!inRange(value)) {
    throw new MoneyOverflowError('amount is outside the signed 128 bit range');
  }
  return value;
}

/** Returns the parsed amount, or null when it is well formed but too long to be in range. */
function parseAmount(amount: unknown): bigint | null {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount !== 'string' || !CANONICAL_INTEGER.test(amount) || amount === '-0') {
    throw new InvalidAmountError('amount must be a bigint or a canonical integer string');
  }
  const digits = amount.startsWith('-') ? amount.length - 1 : amount.length;
  return digits > MAX_I128_DIGITS ? null : BigInt(amount);
}

function parseScale(scale: unknown): number {
  if (typeof scale !== 'number' || !Number.isSafeInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new InvalidScaleError(`scale must be an integer from 0 to ${String(MAX_SCALE)}`);
  }
  // Collapses -0 so Object.is and serialisers never see a signed zero.
  return scale === 0 ? 0 : scale;
}

function build(amount: bigint, currency: CurrencyCode, scale: number): Money {
  return Object.freeze({ amount: checked(amount), currency, scale });
}

export function money(amount: bigint | string, currency: CurrencyCode, scale: number): Money {
  const parsed = parseAmount(amount);
  if (!isCurrencyCode(currency)) {
    throw new UnknownCurrencyError('unknown currency code');
  }
  const normalScale = parseScale(scale);
  if (parsed === null) {
    throw new MoneyOverflowError('amount is outside the signed 128 bit range');
  }
  return build(parsed, currency, normalScale);
}

// Values can arrive from untyped callers, so the amount type is checked at
// runtime instead of trusting the Money annotation.
function amountOf(value: Money): bigint {
  const amount: unknown = value.amount;
  if (typeof amount !== 'bigint') {
    throw new InvalidAmountError('money amount must be a bigint');
  }
  return amount;
}

function assertSameUnit(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(`cannot combine ${a.currency} with ${b.currency}`);
  }
  if (a.scale !== b.scale) {
    throw new ScaleMismatchError(
      `cannot combine ${a.currency} at scale ${String(a.scale)} with scale ${String(b.scale)}`,
    );
  }
}

function operands(a: Money, b: Money): [bigint, bigint] {
  const x = amountOf(a);
  const y = amountOf(b);
  assertSameUnit(a, b);
  return [x, y];
}

export function add(a: Money, b: Money): Money {
  const [x, y] = operands(a, b);
  return build(x + y, a.currency, a.scale);
}

export function subtract(a: Money, b: Money): Money {
  const [x, y] = operands(a, b);
  return build(x - y, a.currency, a.scale);
}

export function multiply(a: Money, factor: bigint): Money {
  const x = amountOf(a);
  const k: unknown = factor;
  if (typeof k !== 'bigint') {
    throw new InvalidAmountError('factor must be a bigint');
  }
  return build(x * k, a.currency, a.scale);
}

export function negate(a: Money): Money {
  return build(-amountOf(a), a.currency, a.scale);
}

export function sum(items: readonly Money[]): Money {
  const [first, ...rest] = items;
  if (first === undefined) {
    throw new InvalidAmountError('cannot sum an empty list, its currency is unknown');
  }
  // Checking after every step matches add exactly, so a total that would
  // dip out of range and come back still throws.
  return rest.reduce(add, add(first, build(0n, first.currency, first.scale)));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  const [x, y] = operands(a, b);
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return compare(a, b) === 0;
}

export function isZero(a: Money): boolean {
  return amountOf(a) === 0n;
}

export function isNegative(a: Money): boolean {
  return amountOf(a) < 0n;
}
