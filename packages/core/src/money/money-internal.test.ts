// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The money module's internal helpers and allocate's weights length check.
// build and snapshot are exported from money.ts for sibling modules only, so
// they must validate on their own and never leak through a public index.

import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
import { allocate } from './allocate.js';
import * as moneyIndex from './index.js';
import { InvalidScaleError, MoneyOverflowError, UnknownCurrencyError, money } from './index.js';
import type { Money, MoneyError } from './index.js';
import { build } from './money.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);

type ErrorClass = abstract new (message?: string) => MoneyError;
const InvalidAllocationError = (moneyIndex as Record<string, unknown>)[
  'InvalidAllocationError'
] as ErrorClass;

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

function expectMoneyError(run: () => unknown, Expected: ErrorClass): void {
  const err = thrown(run);
  expect(Expected).toBeTypeOf('function');
  expect(err).toBeInstanceOf(Expected);
}

const usd = (amount: bigint): Money => money(amount, 'USD', 2);

describe('build validates what it mints', () => {
  it('rejects an unknown currency', () => {
    expectMoneyError(() => build(5n, loose('BTC'), 2), UnknownCurrencyError);
    expectMoneyError(() => build(5n, loose('usd'), 2), UnknownCurrencyError);
    expectMoneyError(() => build(5n, loose(null), 2), UnknownCurrencyError);
  });

  it('rejects an invalid scale', () => {
    for (const scale of [1.5, -1, 19, Number.NaN, Number.POSITIVE_INFINITY, '2', 2n, null]) {
      expectMoneyError(() => build(5n, 'USD', loose(scale)), InvalidScaleError);
    }
  });

  it('rejects an amount outside i128', () => {
    expectMoneyError(() => build(MAX + 1n, 'USD', 2), MoneyOverflowError);
    expectMoneyError(() => build(MIN - 1n, 'USD', 2), MoneyOverflowError);
  });

  it('checks currency before scale before range', () => {
    expectMoneyError(() => build(MAX + 1n, loose('BTC'), 1.5), UnknownCurrencyError);
    expectMoneyError(() => build(MAX + 1n, 'USD', 1.5), InvalidScaleError);
  });

  it('mints a frozen value at the exact boundaries', () => {
    const top = build(MAX, 'USDm', 18);
    expect(top).toEqual({ amount: MAX, currency: 'USDm', scale: 18 });
    expect(Object.isFrozen(top)).toBe(true);
    expect(build(MIN, 'USD', 0).amount).toBe(MIN);
  });

  it('stores a negative zero scale as zero', () => {
    expect(Object.is(build(1n, 'USD', -0).scale, 0)).toBe(true);
  });

  it('is not exported from the money index or the package root', () => {
    const fromIndex = moneyIndex as Record<string, unknown>;
    const fromRoot = root as Record<string, unknown>;
    expect(fromIndex['build']).toBeUndefined();
    expect(fromRoot['build']).toBeUndefined();
    expect(fromIndex['snapshot']).toBeUndefined();
    expect(fromRoot['snapshot']).toBeUndefined();
  });
});

/** A real array whose length reads come back as `length`. */
function withLength(length: unknown, items: readonly unknown[] = [1n, 1n]): readonly bigint[] {
  const proxy = new Proxy([...items], {
    get(target, key, receiver) {
      if (key === 'length') return length;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return loose(proxy);
}

describe('allocate rejects a weights length that is not a whole count', () => {
  it.each([
    ['-1', -1],
    ['NaN', Number.NaN],
    ['1.5', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-0', -0],
    ['0.5', 0.5],
    ['16.5', 16.5],
    ['a numeric string', '2'],
    ['a bigint', 2n],
    ['undefined', undefined],
  ])('rejects a length of %s', (_label, length) => {
    expectMoneyError(() => allocate(usd(100n), withLength(length)), InvalidAllocationError);
  });

  it('never reads a weight when the length is not a whole count', () => {
    for (const length of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const reads: string[] = [];
      const proxy = new Proxy([1n, 1n], {
        get(target, key, receiver) {
          if (key === 'length') return length;
          if (typeof key === 'string' && /^[0-9]+$/.test(key)) reads.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      thrown(() => allocate(usd(100n), loose(proxy)));
      expect(reads).toEqual([]);
    }
  });

  it('still accepts a whole length from a proxy', () => {
    const legs = allocate(usd(100n), withLength(2));
    expect(legs.map((leg) => leg.amount)).toEqual([50n, 50n]);
  });
});
