// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Money operands and option bags are read from the caller's own fields only.
// A polluted Object.prototype or Array.prototype, a class instance or an
// object with a custom prototype must never pass as a Money value or change
// an option. Plain objects, null prototype objects and proxies over plain
// objects keep working.

import { afterEach, describe, expect, it } from 'vitest';

import { allocate } from './allocate.js';
import { formatMoney } from './format.js';
import * as moneyIndex from './index.js';
import {
  InvalidAmountError,
  UnknownCurrencyError,
  add,
  compare,
  equals,
  isNegative,
  isZero,
  money,
  multiply,
  negate,
  subtract,
  sum,
} from './index.js';
import type { Money, MoneyError } from './index.js';
import { parseMoney, toDecimalString } from './parse.js';
import { rescale } from './rescale.js';

type ErrorClass = abstract new (message?: string) => MoneyError;
const exported = (name: string): ErrorClass =>
  (moneyIndex as Record<string, unknown>)[name] as ErrorClass;
const InvalidAllocationError = exported('InvalidAllocationError');
const InvalidLocaleError = exported('InvalidLocaleError');
const InvalidRoundingModeError = exported('InvalidRoundingModeError');

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

function expectError(run: () => unknown, Expected: ErrorClass): void {
  expect(Expected).toBeTypeOf('function');
  expect(thrown(run)).toBeInstanceOf(Expected);
}

const usd = (amount: bigint): Money => money(amount, 'USD', 2);

// JSON keeps "__proto__" as an own key, and Object.assign then sets it as
// the prototype of the target, the way a careless body merge would.
function protoKeyed(): object {
  const parsed: unknown = JSON.parse('{"__proto__": {"amount": "x"}}');
  return parsed as object;
}

// Every operation that takes a Money operand, each given `value`.
const operations: [string, (value: Money) => unknown][] = [
  ['add, first', (v) => add(v, usd(1n))],
  ['add, second', (v) => add(usd(1n), v)],
  ['subtract', (v) => subtract(v, usd(1n))],
  ['multiply', (v) => multiply(v, 2n)],
  ['negate', (v) => negate(v)],
  ['sum', (v) => sum([usd(1n), v])],
  ['compare', (v) => compare(usd(1n), v)],
  ['equals', (v) => equals(v, usd(1n))],
  ['isZero', (v) => isZero(v)],
  ['isNegative', (v) => isNegative(v)],
  ['allocate', (v) => allocate(v, [1n, 1n])],
  ['rescale', (v) => rescale(v, 4, 'half-even')],
  ['toDecimalString', (v) => toDecimalString(v)],
  ['formatMoney', (v) => formatMoney(v, { locale: 'en-US' })],
];

const objectProto = Object.prototype as Record<string, unknown>;
const arrayProto = Array.prototype as unknown as Record<string, unknown>;

afterEach(() => {
  delete objectProto['amount'];
  delete objectProto['currency'];
  delete objectProto['scale'];
  delete objectProto['rounding'];
  delete objectProto['locale'];
  delete arrayProto['1'];
});

describe('Money operands under a polluted Object.prototype', () => {
  it.each(operations)('%s rejects {} even when the prototype carries valid fields', (_n, op) => {
    objectProto['amount'] = 1n;
    objectProto['currency'] = 'USD';
    objectProto['scale'] = 2;
    expectError(() => op(loose({})), InvalidAmountError);
  });

  it.each(operations)('%s ignores a polluted currency and scale', (_n, op) => {
    objectProto['currency'] = 'USD';
    objectProto['scale'] = 2;
    // Only the amount is the caller's own, so the snapshot has no currency.
    expectError(() => op(loose({ amount: 1n })), UnknownCurrencyError);
  });

  it('still accepts a well formed plain operand while the prototype is polluted', () => {
    objectProto['currency'] = 'NGN';
    objectProto['scale'] = 6;
    expect(add(loose({ amount: 1n, currency: 'USD', scale: 2 }), usd(1n))).toEqual(usd(2n));
  });
});

describe('Money operands with a prototype other than Object.prototype or null', () => {
  class Row {
    readonly amount = 1n;
    readonly currency = 'USD';
    readonly scale = 2;
  }

  const shapes: [string, () => unknown][] = [
    ['an object inheriting from a real Money', () => Object.create(usd(5n)) as unknown],
    [
      'an object inheriting valid fields',
      () => Object.create({ amount: 1n, currency: 'USD', scale: 2 }) as unknown,
    ],
    ['a class instance with its own fields', () => new Row()],
    [
      'an object whose prototype was set through a __proto__ key',
      () =>
        Object.assign({}, protoKeyed(), {
          amount: 1n,
          currency: 'USD',
          scale: 2,
        }),
    ],
    [
      'an array with Money fields',
      () => Object.assign([], { amount: 1n, currency: 'USD', scale: 2 }),
    ],
  ];

  it('builds the shapes the way the cases expect', () => {
    const viaProto = shapes[3]?.[1]();
    expect(Object.getPrototypeOf(viaProto)).not.toBe(Object.prototype);
  });

  for (const [label, make] of shapes) {
    it.each(operations)(`%s rejects ${label}`, (_n, op) => {
      expectError(() => op(loose(make())), InvalidAmountError);
    });
  }

  it('accepts a null prototype object with own fields', () => {
    const row = Object.assign(Object.create(null) as object, {
      amount: 250n,
      currency: 'KES',
      scale: 2,
    });
    expect(add(loose(row), money(50n, 'KES', 2))).toEqual(money(300n, 'KES', 2));
    expect(toDecimalString(loose(row))).toBe('2.50');
  });

  it('accepts a proxy over a plain object', () => {
    const proxy = new Proxy({ amount: 7n, currency: 'USD', scale: 2 }, {});
    expect(negate(loose(proxy))).toEqual(usd(-7n));
  });
});

describe('list holes under a polluted Array.prototype', () => {
  it('sum treats a hole as missing, not as the inherited value', () => {
    arrayProto['1'] = usd(1n);
    const holey = new Array<Money>(3);
    holey[0] = usd(1n);
    holey[2] = usd(1n);
    expectError(() => sum(holey), InvalidAmountError);
  });

  it('allocate treats a weight hole as missing, not as the inherited value', () => {
    arrayProto['1'] = 1n;
    const holey = new Array<bigint>(3);
    holey[0] = 1n;
    holey[2] = 1n;
    expectError(() => allocate(usd(100n), holey), InvalidAllocationError);
  });

  it('still sums and allocates dense arrays while Array.prototype is polluted', () => {
    arrayProto['1'] = usd(1000n);
    expect(sum([usd(1n), usd(2n), usd(3n)])).toEqual(usd(6n));
    expect(allocate(usd(100n), [1n, 1n, 1n]).map((m) => m.amount)).toEqual([34n, 33n, 33n]);
  });
});

describe('option bags', () => {
  class Options {
    readonly locale = 'en-US';
    readonly rounding = 'ceil';
  }

  it('parseMoney rejects options with a prototype other than Object.prototype or null', () => {
    const shapes: unknown[] = [
      Object.create({ rounding: 'ceil' }) as unknown,
      new Options(),
      Object.assign([], { rounding: 'ceil' }),
    ];
    for (const options of shapes) {
      expectError(() => parseMoney('1.005', 'USD', 2, loose(options)), InvalidRoundingModeError);
    }
  });

  it('formatMoney rejects options with a prototype other than Object.prototype or null', () => {
    const shapes: unknown[] = [
      Object.create({ locale: 'en-US' }) as unknown,
      new Options(),
      Object.assign([], { locale: 'en-US' }),
    ];
    for (const options of shapes) {
      expectError(() => formatMoney(usd(150n), loose(options)), InvalidLocaleError);
    }
  });

  it('accepts null prototype option bags', () => {
    const parseOptions = Object.assign(Object.create(null) as object, { rounding: 'ceil' });
    expect(parseMoney('1.001', 'USD', 2, loose(parseOptions)).amount).toBe(101n);
    const formatOptions = Object.assign(Object.create(null) as object, { locale: 'en-US' });
    expect(formatMoney(usd(150n), loose(formatOptions))).toBe('$1.50');
  });

  it('ignores options polluted onto Object.prototype', () => {
    objectProto['rounding'] = 'ceil';
    objectProto['locale'] = 'en-US';
    expectError(() => parseMoney('1.001', 'USD', 2, {}), InvalidAmountError);
    expectError(() => formatMoney(usd(150n), loose({})), InvalidLocaleError);
  });
});

describe('prototype cleanup', () => {
  it('leaves Object.prototype and Array.prototype clean', () => {
    for (const key of ['amount', 'currency', 'scale', 'rounding', 'locale']) {
      expect(Object.hasOwn(Object.prototype, key)).toBe(false);
    }
    expect(Object.hasOwn(Array.prototype, '1')).toBe(false);
  });
});
