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
import { isPlainRecord, readOwnField } from './options.js';

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

const OVERFLOW_MESSAGE = 'amount is outside the signed 128 bit range';

function checked(value: bigint): bigint {
  if (value < I128_MIN || value > I128_MAX) {
    throw new MoneyOverflowError(OVERFLOW_MESSAGE);
  }
  return value;
}

/** Returns the parsed amount, or null when it is well formed but too long to be in range. */
function parseAmount(amount: unknown): bigint | null {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount !== 'string' || !CANONICAL_INTEGER.test(amount) || amount === '-0') {
    throw new InvalidAmountError('amount must be a bigint or a canonical integer string');
  }
  const digits = amount.startsWith('-') ? amount.slice(1) : amount;
  return digits.length > MAX_I128_DIGITS ? null : BigInt(amount);
}

function isScale(scale: unknown): scale is number {
  return (
    typeof scale === 'number' && Number.isSafeInteger(scale) && scale >= 0 && scale <= MAX_SCALE
  );
}

function parseScale(scale: unknown): number {
  if (!isScale(scale)) {
    throw new InvalidScaleError(`scale must be an integer from 0 to ${String(MAX_SCALE)}`);
  }
  // Collapses -0 so Object.is and serialisers never see a signed zero.
  return scale === 0 ? 0 : scale;
}

function parseCurrency(currency: unknown): CurrencyCode {
  if (!isCurrencyCode(currency)) {
    throw new UnknownCurrencyError('unknown currency code');
  }
  return currency;
}

// Exported for sibling modules such as allocate. Lint keeps it inside the
// money module and the indexes never re-export it. It validates on its own
// anyway, so a caller in this module cannot mint a value money() would refuse.
export function build(amount: bigint, currency: CurrencyCode, scale: number): Money {
  const code = parseCurrency(currency);
  const normalScale = parseScale(scale);
  // The range check uses < and >, which compare a number or a string with a
  // bigint without throwing, so the type has to be checked on its own.
  const value: unknown = amount;
  if (typeof value !== 'bigint') {
    throw new InvalidAmountError('money amount must be a bigint');
  }
  return Object.freeze({ amount: checked(value), currency: code, scale: normalScale });
}

export function money(amount: bigint | string, currency: CurrencyCode, scale: number): Money {
  const parsed = parseAmount(amount);
  const code = parseCurrency(currency);
  const normalScale = parseScale(scale);
  if (parsed === null) {
    throw new MoneyOverflowError(OVERFLOW_MESSAGE);
  }
  return build(parsed, code, normalScale);
}

/**
 * Operands can be rows from a mapper or anything an untyped caller passes,
 * and a getter can answer differently on every read. So each field is read
 * exactly once, validated like money() does, and only this copy is used.
 */
export function snapshot(value: Money): Money {
  const candidate: unknown = value;
  if (!isPlainRecord(candidate)) {
    throw new InvalidAmountError('expected a plain money value');
  }
  const amount = readOwnField(candidate, 'amount');
  const currency = readOwnField(candidate, 'currency');
  const scale = readOwnField(candidate, 'scale');
  if (typeof amount !== 'bigint') {
    throw new InvalidAmountError('money amount must be a bigint');
  }
  const code = parseCurrency(currency);
  const normalScale = parseScale(scale);
  return { amount: checked(amount), currency: code, scale: normalScale };
}

// Only ever called on validated snapshots, so the text it interpolates is a
// known currency code or a small integer, never caller supplied.
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

function pair(a: Money, b: Money): [Money, Money] {
  const x = snapshot(a);
  const y = snapshot(b);
  assertSameUnit(x, y);
  return [x, y];
}

export function add(a: Money, b: Money): Money {
  const [x, y] = pair(a, b);
  return build(x.amount + y.amount, x.currency, x.scale);
}

export function subtract(a: Money, b: Money): Money {
  const [x, y] = pair(a, b);
  return build(x.amount - y.amount, x.currency, x.scale);
}

export function multiply(a: Money, factor: bigint): Money {
  const x = snapshot(a);
  const k: unknown = factor;
  if (typeof k !== 'bigint') {
    throw new InvalidAmountError('factor must be a bigint');
  }
  return build(x.amount * k, x.currency, x.scale);
}

export function negate(a: Money): Money {
  const x = snapshot(a);
  return build(-x.amount, x.currency, x.scale);
}

export function sum(items: readonly Money[]): Money {
  const list: unknown = items;
  if (!Array.isArray(list)) {
    throw new InvalidAmountError('sum expects an array of money values');
  }
  let total: Money | undefined;
  // A hole is read as missing rather than through Array.prototype, so it
  // fails validation like null does even if that prototype is polluted.
  for (const index of list.keys()) {
    const item: unknown = Object.hasOwn(list, index) ? list[index] : undefined;
    const next = snapshot(item as Money);
    if (total === undefined) {
      total = next;
      continue;
    }
    assertSameUnit(total, next);
    // Checking after every step matches repeated add, so a total that would
    // dip out of range and come back still throws.
    total = {
      amount: checked(total.amount + next.amount),
      currency: total.currency,
      scale: total.scale,
    };
  }
  if (total === undefined) {
    throw new InvalidAmountError('cannot sum an empty list, its currency is unknown');
  }
  return build(total.amount, total.currency, total.scale);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  const [x, y] = pair(a, b);
  if (x.amount < y.amount) return -1;
  return x.amount > y.amount ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return compare(a, b) === 0;
}

export function isZero(a: Money): boolean {
  return snapshot(a).amount === 0n;
}

export function isNegative(a: Money): boolean {
  return snapshot(a).amount < 0n;
}
