// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Public contract for money text in and out: parse.ts, rescale.ts and
 * format.ts in packages/core/src/money, all exported from ./index.js and
 * re-exported from the package root. The contract in money.test.ts and the
 * single read snapshot rules in money-forged.test.ts still apply. Everything
 * is bigint and string work only; the money float ban covers these files.
 *
 * Types and constants
 *   type RoundingMode = 'half-even' | 'half-up' | 'floor' | 'ceil' | 'trunc'
 *     half-even  nearest, ties to the even neighbour
 *     half-up    nearest, ties away from zero (-1.005 to 2 places is -1.01)
 *     floor      toward negative infinity
 *     ceil       toward positive infinity
 *     trunc      toward zero
 *   ROUNDING_MODES: readonly RoundingMode[]   frozen, exactly the five above
 *   A rounding mode is only ever one of those exact strings. Anything else
 *   (undefined, 'HALF_EVEN', 'round', a boxed string, an object) throws
 *   InvalidRoundingModeError. There is no default mode for rescale.
 *
 * New errors (extend MoneyError, `name` equals the class name)
 *   InvalidRoundingModeError  code 'INVALID_ROUNDING'
 *   InvalidLocaleError        code 'INVALID_LOCALE'
 *
 * parseMoney(input: string, currency: CurrencyCode, scale: number,
 *            options?: { rounding?: RoundingMode }): Money
 *   Grammar, ASCII only: /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/
 *     no exponent, no thousands or other separators, no leading +, no
 *     whitespace anywhere, no empty integer or fraction part, no leading
 *     zeros, no unicode digits, at most 100 characters.
 *     A negative zero ("-0", "-0.00") is rejected, as money() rejects "-0".
 *   Validation order: input is a string, then length, then grammar
 *   (InvalidAmountError), then currency (UnknownCurrencyError), then scale
 *   (InvalidScaleError, integer 0..18), then options.rounding when present
 *   (InvalidRoundingModeError), then fraction length, then range.
 *   A fraction shorter than scale is padded. A fraction longer than scale
 *   throws InvalidAmountError, even when the extra digits are zeros, unless
 *   options.rounding is given, in which case the exact value is rounded to
 *   scale with that mode. Values outside i128 at scale throw
 *   MoneyOverflowError. Non string input never has toString, valueOf or
 *   Symbol.toPrimitive called. options fields are read at most once.
 *   Error messages never echo the input and are at most 200 characters with
 *   no line breaks.
 *
 * toDecimalString(m: Money): string
 *   Canonical plain decimal with exactly m.scale fraction digits: 1230 at
 *   scale 2 is "12.30", -5 at scale 2 is "-0.05", 7 at scale 0 is "7".
 *   Never a negative zero.
 *
 * rescale(m: Money, toScale: number, rounding: RoundingMode): Money
 *   Validation order: snapshot of m, then toScale (InvalidScaleError), then
 *   rounding (InvalidRoundingModeError, required on every call, even when
 *   scaling up). Scaling up multiplies exactly and throws MoneyOverflowError
 *   outside i128. Scaling down divides by a power of ten with the mode. The
 *   result keeps the currency and is frozen.
 *
 * formatMoney(m: Money, options: { locale: string; rounding?: RoundingMode }): string
 *   Rescales m down to the display scale with rescale (default rounding
 *   half-even), then formats the decimal string from toDecimalString with
 *   Intl.NumberFormat. A stored scale below the display scale is padded on
 *   the decimal string, so formatMoney never overflows on a valid Money
 *   (I128_MAX at scale 0 still prints with ".00"). A JavaScript number is
 *   never formed, so every digit of an i128 amount survives.
 *   Display scale: fiat minorUnits (2 for every launch currency); tokens use
 *   the shared displayScale (2).
 *   Fiat: style currency, currencyDisplay narrowSymbol, exactly two fraction
 *   digits, numberingSystem latn (ASCII digits in every locale), with one
 *   brand override: KES shows "KSh" where ICU says "Ksh" or "KES". The
 *   currency symbol never depends on the locale, only its position and the
 *   grouping do. Brand symbols: NGN ₦, KES KSh, GHS GH₵, ZAR R, PHP ₱, INR ₹,
 *   BRL R$, COP $, MXN $, USD $, EUR €, GBP £.
 *   Tokens: the locale's decimal format with two fraction digits, latn
 *   digits, then U+00A0 and the asset code, for example "1.23\u00a0USDC".
 *   A value that rounds to zero prints without a minus sign.
 *   Typography is the same in every locale. A negative amount uses the true
 *   minus sign U+2212, never an ASCII hyphen. Every space in the output,
 *   between digit groups and between a symbol or asset code and the number,
 *   is U+00A0: ICU's U+202F (fr-FR grouping, for example) becomes U+00A0.
 *   Right to left locales can include bidi control marks around the minus
 *   or the symbol, so the output is for display only and is never parsed,
 *   compared or stored. Digits are ASCII for fiat and tokens alike.
 *   toDecimalString is for data, not display: it always uses an ASCII
 *   hyphen minus, a full stop and ASCII digits, with no spaces or marks.
 *   locale must be a string Intl accepts; anything else (missing options,
 *   non string, empty, malformed tag) throws InvalidLocaleError without
 *   calling toString on it. A bad rounding throws InvalidRoundingModeError.
 *   options.locale and options.rounding are each read at most once.
 *   Validation order: snapshot of m, then options and locale, then rounding.
 */

import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
import * as moneyIndex from './index.js';
import {
  InvalidAmountError,
  InvalidScaleError,
  MoneyError,
  MoneyOverflowError,
  UnknownCurrencyError,
  money,
} from './index.js';
import type { Money } from './index.js';
import { parseMoney, toDecimalString } from './parse.js';
import type { RoundingMode } from './rescale.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const MAX_MESSAGE_LENGTH = 200;

type ErrorClass = abstract new (message?: string) => MoneyError;
// Looked up by name so a missing export fails assertions rather than the import.
const exported = (name: string): unknown => (moneyIndex as Record<string, unknown>)[name];
const InvalidRoundingModeError = exported('InvalidRoundingModeError') as ErrorClass;

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
  expect(Expected).toBeTypeOf('function');
  expect(err).toBeInstanceOf(Expected);
  return err as MoneyError;
}

function expectSafeMessage(err: MoneyError): void {
  expect(err.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  expect(err.message).not.toMatch(/[\r\n\u2028\u2029]/);
}

function expectMoney(value: Money, amount: bigint, currency: string, scale: number): void {
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.keys(value).sort()).toEqual(['amount', 'currency', 'scale']);
  expect(value.amount).toBe(amount);
  expect(value.currency).toBe(currency);
  expect(value.scale).toBe(scale);
}

describe('exports', () => {
  it('exposes the text api from the money index and the package root', () => {
    const fromRoot = root as Record<string, unknown>;
    for (const name of [
      'parseMoney',
      'toDecimalString',
      'rescale',
      'formatMoney',
      'ROUNDING_MODES',
      'InvalidRoundingModeError',
      'InvalidLocaleError',
    ]) {
      expect(exported(name), name).toBeDefined();
      expect(fromRoot[name], name).toBe(exported(name));
    }
    expect(exported('parseMoney')).toBe(parseMoney);
    expect(exported('toDecimalString')).toBe(toDecimalString);
  });

  it('lists exactly five rounding modes in a frozen array', () => {
    const modes = exported('ROUNDING_MODES') as readonly string[];
    expect(modes).toEqual(['half-even', 'half-up', 'floor', 'ceil', 'trunc']);
    expect(Object.isFrozen(modes)).toBe(true);
  });

  it.each([
    ['InvalidRoundingModeError', 'INVALID_ROUNDING'],
    ['InvalidLocaleError', 'INVALID_LOCALE'],
  ])('%s has a stable code and extends MoneyError', (name, code) => {
    const Ctor = exported(name) as new (message?: string) => MoneyError;
    expect(Ctor).toBeTypeOf('function');
    const err = new Ctor('boom');
    expect(err).toBeInstanceOf(MoneyError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(name);
    expect(err.code).toBe(code);
  });
});

describe('parseMoney accepts the strict grammar', () => {
  const cases: [string, number, bigint][] = [
    ['0', 2, 0n],
    ['0.00', 2, 0n],
    ['1', 2, 100n],
    ['1.5', 2, 150n],
    ['12.30', 2, 1230n],
    ['-12.30', 2, -1230n],
    ['-0.05', 2, -5n],
    ['0.5', 1, 5n],
    ['7', 0, 7n],
    ['1234567890', 2, 123456789000n],
    ['0.000000000000000001', 18, 1n],
    ['1.000000000000000000', 18, 10n ** 18n],
    ['170141183460469231731687303715884105727', 0, MAX],
    ['-170141183460469231731687303715884105728', 0, MIN],
    ['1701411834604692317316873037158841057.27', 2, MAX],
    ['-170141183460469231731.687303715884105728', 18, MIN],
  ];

  it.each(cases)('parses %s at scale %d', (input, scale, amount) => {
    expectMoney(parseMoney(input, 'USD', scale), amount, 'USD', scale);
  });

  it('keeps the currency it was given, fiat or token', () => {
    expectMoney(parseMoney('20000', 'NGN', 2), 2_000_000n, 'NGN', 2);
    expectMoney(parseMoney('1.234567', 'USDC', 6), 1_234_567n, 'USDC', 6);
    expectMoney(parseMoney('1.2345678', 'USDC', 7), 12_345_678n, 'USDC', 7);
    expectMoney(parseMoney('5', 'USDm', 18), 5n * 10n ** 18n, 'USDm', 18);
  });

  it('equals money() for the same value', () => {
    expect(parseMoney('-42.07', 'KES', 2)).toEqual(money(-4207n, 'KES', 2));
  });
});

describe('parseMoney rejects malformed input', () => {
  it('rejects 1e3, 1,000, +1, " 1", "1.", ".5" and ""', () => {
    for (const input of ['1e3', '1,000', '+1', ' 1', '1.', '.5', '']) {
      expectMoneyError(() => parseMoney(input, 'USD', 2), InvalidAmountError);
    }
  });

  const malformed: string[] = [
    '1E3',
    '1e-2',
    '1.5e2',
    '1_000',
    '1 000',
    '1\u00a0000',
    '1\u202f000',
    "1'000",
    '1.000,00',
    '1,5',
    '0x10',
    '0b1',
    '0o7',
    '1n',
    '01',
    '00',
    '00.5',
    '-01',
    '-',
    '--1',
    '- 1',
    '+-1',
    '1-',
    '1 ',
    '\t1',
    '1\n',
    '\n1',
    '1\r\n',
    '1\u2028',
    '1.2.3',
    '1..2',
    '..',
    '.',
    '-.5',
    '-1.',
    'Infinity',
    '-Infinity',
    'NaN',
    'one',
    '$1',
    '1$',
    '1 USD',
    '\u0661',
    '\u0661\u0662\u0663',
    '\uff11',
    '1\uff10',
    '\u0967',
    '\u{1d7cf}',
    '1\u0301',
    '\u200b1',
    '1\u200b',
    '\ufeff1',
    '\u22121',
    '\u20101',
  ];

  it.each(malformed)('rejects %j', (input) => {
    expectMoneyError(() => parseMoney(input, 'USD', 2), InvalidAmountError);
  });

  it('rejects a negative zero in every spelling', () => {
    for (const input of ['-0', '-0.0', '-0.00']) {
      expectMoneyError(() => parseMoney(input, 'USD', 2), InvalidAmountError);
    }
  });

  it('rejects inputs over 100 characters before anything else', () => {
    const long = '1'.repeat(101);
    expectMoneyError(() => parseMoney(long, 'USD', 2), InvalidAmountError);
    expectMoneyError(() => parseMoney('0.' + '0'.repeat(99), 'USD', 2), InvalidAmountError);
    expectMoneyError(() => parseMoney('1'.repeat(1_000_000), 'USD', 2), InvalidAmountError);
    // Exactly 100 characters passes length and fails only on range.
    expectMoneyError(() => parseMoney('1'.repeat(100), 'USD', 0), MoneyOverflowError);
  });

  const nonStrings: [string, unknown][] = [
    ['a number', 1],
    ['a float', 1.5],
    ['a bigint', 1n],
    ['a boxed string', Object('1')],
    ['null', null],
    ['undefined', undefined],
    ['an array', ['1']],
    ['an object', { amount: '1' }],
    ['a symbol', Symbol('1')],
  ];

  it.each(nonStrings)('rejects %s as input', (_label, input) => {
    expectMoneyError(() => parseMoney(loose(input), 'USD', 2), InvalidAmountError);
  });

  it('never calls toString, valueOf or Symbol.toPrimitive on the input', () => {
    const calls: string[] = [];
    const hostile = {
      toString() {
        calls.push('toString');
        return '1';
      },
      valueOf() {
        calls.push('valueOf');
        return 1;
      },
      [Symbol.toPrimitive]() {
        calls.push('toPrimitive');
        return '1';
      },
    };
    expectSafeMessage(
      expectMoneyError(() => parseMoney(loose(hostile), 'USD', 2), InvalidAmountError),
    );
    expect(calls).toEqual([]);
  });

  it('keeps the input out of the error message', () => {
    const err = expectMoneyError(
      () => parseMoney('1\nlevel=info msg=paid', 'USD', 2),
      InvalidAmountError,
    );
    expectSafeMessage(err);
    expect(err.message).not.toContain('msg=paid');
    expectSafeMessage(
      expectMoneyError(() => parseMoney('9'.repeat(100), 'USD', 0), MoneyOverflowError),
    );
  });
});

describe('parseMoney precision', () => {
  it('rejects 1.001 for USD', () => {
    expectMoneyError(() => parseMoney('1.001', 'USD', 2), InvalidAmountError);
  });

  it('rejects excess fraction digits even when they are zeros', () => {
    expectMoneyError(() => parseMoney('1.000', 'USD', 2), InvalidAmountError);
    expectMoneyError(() => parseMoney('1.0', 'KES', 0), InvalidAmountError);
    expectMoneyError(() => parseMoney('0.0000001', 'USDC', 6), InvalidAmountError);
    expectMoneyError(() => parseMoney('0.0000000000000000001', 'USDm', 18), InvalidAmountError);
  });

  it('pads a short fraction', () => {
    expectMoney(parseMoney('1.2', 'USDC', 6), 1_200_000n, 'USDC', 6);
  });

  it('rounds excess digits only when a mode is given', () => {
    const cases: [string, RoundingMode, bigint][] = [
      ['1.005', 'half-even', 100n],
      ['1.005', 'half-up', 101n],
      ['1.015', 'half-even', 102n],
      ['1.009', 'floor', 100n],
      ['1.001', 'ceil', 101n],
      ['1.009', 'trunc', 100n],
      ['-1.005', 'half-even', -100n],
      ['-1.005', 'half-up', -101n],
      ['-1.001', 'floor', -101n],
      ['-1.009', 'ceil', -100n],
      ['-1.009', 'trunc', -100n],
      ['1.000', 'half-even', 100n],
      ['1.00500000000000000000001', 'half-even', 101n],
    ];
    for (const [input, rounding, amount] of cases) {
      expectMoney(parseMoney(input, 'USD', 2, { rounding }), amount, 'USD', 2);
    }
  });

  it('a value that rounds to zero is a plain zero', () => {
    expectMoney(parseMoney('-0.001', 'USD', 2, { rounding: 'half-even' }), 0n, 'USD', 2);
    expectMoney(parseMoney('-0.4', 'USD', 0, { rounding: 'trunc' }), 0n, 'USD', 0);
  });

  it('checks range after rounding', () => {
    expectMoney(
      parseMoney('170141183460469231731687303715884105727.4', 'USD', 0, { rounding: 'half-even' }),
      MAX,
      'USD',
      0,
    );
    expectMoneyError(
      () =>
        parseMoney('170141183460469231731687303715884105727.5', 'USD', 0, {
          rounding: 'half-up',
        }),
      MoneyOverflowError,
    );
    expectMoneyError(
      () => parseMoney('170141183460469231731687303715884105728', 'USD', 0),
      MoneyOverflowError,
    );
    expectMoneyError(
      () => parseMoney('-170141183460469231731687303715884105729', 'USD', 0),
      MoneyOverflowError,
    );
    expectMoneyError(
      () => parseMoney('1701411834604692317316873037158841057.28', 'USD', 2),
      MoneyOverflowError,
    );
  });

  it('accepts an empty options object and an explicit undefined rounding as no rounding', () => {
    expectMoney(parseMoney('1.5', 'USD', 2, {}), 150n, 'USD', 2);
    expectMoneyError(() => parseMoney('1.005', 'USD', 2, {}), InvalidAmountError);
    expectMoneyError(
      () => parseMoney('1.005', 'USD', 2, loose({ rounding: undefined })),
      InvalidAmountError,
    );
  });

  it('rejects an unknown rounding mode even when no rounding is needed', () => {
    for (const rounding of ['HALF_EVEN', 'round', 'halfEven', 'half_up', '', 'ceiling', 'down']) {
      expectMoneyError(
        () => parseMoney('1.5', 'USD', 2, loose({ rounding })),
        InvalidRoundingModeError,
      );
    }
    expectMoneyError(
      () => parseMoney('1.5', 'USD', 2, loose({ rounding: Object('half-even') as unknown })),
      InvalidRoundingModeError,
    );
  });

  it('reads options.rounding at most once', () => {
    let reads = 0;
    const answers: unknown[] = ['half-even', 'bogus'];
    const options = {
      get rounding() {
        reads += 1;
        return answers[Math.min(reads, answers.length) - 1];
      },
    };
    expectMoney(parseMoney('1.005', 'USD', 2, loose(options)), 100n, 'USD', 2);
    expect(reads).toBeLessThanOrEqual(1);
  });
});

describe('parseMoney validation order', () => {
  it('checks the input before the currency and the currency before the scale', () => {
    expectMoneyError(() => parseMoney('x', loose('BTC'), 1.5), InvalidAmountError);
    expectMoneyError(() => parseMoney('1', loose('BTC'), 1.5), UnknownCurrencyError);
    expectMoneyError(() => parseMoney('1', 'USD', 1.5), InvalidScaleError);
  });

  it('checks the scale before the rounding and the rounding before precision', () => {
    expectMoneyError(
      () => parseMoney('1.001', 'USD', 19, loose({ rounding: 'bogus' })),
      InvalidScaleError,
    );
    expectMoneyError(
      () => parseMoney('1.001', 'USD', 2, loose({ rounding: 'bogus' })),
      InvalidRoundingModeError,
    );
  });

  it('rejects bad scales', () => {
    for (const scale of [-1, 19, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectMoneyError(() => parseMoney('1', 'USD', scale), InvalidScaleError);
    }
    expectMoneyError(() => parseMoney('1', 'USD', loose('2')), InvalidScaleError);
    expectMoneyError(() => parseMoney('1', 'USD', loose(2n)), InvalidScaleError);
  });

  it('rejects unknown and wrongly cased currencies', () => {
    for (const currency of ['usd', 'BTC', 'USDM', '__proto__', '']) {
      expectMoneyError(() => parseMoney('1', loose(currency), 2), UnknownCurrencyError);
    }
  });
});

describe('toDecimalString', () => {
  const cases: [bigint, number, string][] = [
    [1230n, 2, '12.30'],
    [0n, 2, '0.00'],
    [0n, 0, '0'],
    [5n, 2, '0.05'],
    [-5n, 2, '-0.05'],
    [-100n, 2, '-1.00'],
    [7n, 0, '7'],
    [-7n, 0, '-7'],
    [1n, 18, '0.000000000000000001'],
    [-1n, 18, '-0.000000000000000001'],
    [10n ** 18n, 18, '1.000000000000000000'],
    [MAX, 0, '170141183460469231731687303715884105727'],
    [MIN, 0, '-170141183460469231731687303715884105728'],
    [MAX, 18, '170141183460469231731.687303715884105727'],
    [MIN, 18, '-170141183460469231731.687303715884105728'],
    [900719925474099301n, 2, '9007199254740993.01'],
  ];

  it.each(cases)('prints %s at scale %d as %s', (amount, scale, expected) => {
    expect(toDecimalString(money(amount, 'USD', scale))).toBe(expected);
  });

  it('prints 1230 at scale 2 as 12.30 for every currency', () => {
    for (const currency of ['USD', 'NGN', 'KES', 'USDC', 'USDm'] as const) {
      expect(toDecimalString(money(1230n, currency, 2))).toBe('12.30');
    }
  });

  const forged: [string, unknown, ErrorClass][] = [
    ['null', null, InvalidAmountError],
    ['a number amount', { amount: 1, currency: 'USD', scale: 2 }, InvalidAmountError],
    ['an unknown currency', { amount: 1n, currency: 'BTC', scale: 2 }, UnknownCurrencyError],
    ['a fractional scale', { amount: 1n, currency: 'USD', scale: 1.5 }, InvalidScaleError],
    ['an out of range amount', { amount: MAX + 1n, currency: 'USD', scale: 2 }, MoneyOverflowError],
  ];

  it.each(forged)('rejects a forged operand with %s', (_label, value, Expected) => {
    expectMoneyError(() => toDecimalString(loose(value)), Expected);
  });

  it('reads each field once and prints from the snapshot', () => {
    const reads = { amount: 0, currency: 0, scale: 0 };
    const answers = { amount: [1230n, 9n], currency: ['USD', 'BTC'], scale: [2, 5] };
    const value = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'amount' || key === 'currency' || key === 'scale') {
            reads[key] += 1;
            const list: unknown[] = answers[key];
            return list[Math.min(reads[key], list.length) - 1];
          }
          return undefined;
        },
      },
    );
    expect(toDecimalString(loose(value))).toBe('12.30');
    expect(reads.amount).toBeLessThanOrEqual(1);
    expect(reads.currency).toBeLessThanOrEqual(1);
    expect(reads.scale).toBeLessThanOrEqual(1);
  });
});
