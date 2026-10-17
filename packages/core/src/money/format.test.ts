// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The API contract for formatMoney is documented at the top of parse.test.ts.
// Expected strings come from the ICU data in the pinned Node release (see
// .nvmrc); U+00A0 and U+202F spaces are written as escapes so they are visible.

import { describe, expect, it } from 'vitest';

import { formatMoney } from './format.js';
import * as moneyIndex from './index.js';
import {
  InvalidAmountError,
  InvalidScaleError,
  MoneyOverflowError,
  UnknownCurrencyError,
  money,
} from './index.js';
import type { CurrencyCode, MoneyError } from './index.js';

const MAX = 2n ** 127n - 1n;
const MIN = -(2n ** 127n);
const NBSP = '\u00a0';
// Display output uses the true minus sign in every locale.
const MINUS = '\u2212';

type ErrorClass = abstract new (message?: string) => MoneyError;
const exported = (name: string): ErrorClass =>
  (moneyIndex as Record<string, unknown>)[name] as ErrorClass;
const InvalidRoundingModeError = exported('InvalidRoundingModeError');
const InvalidLocaleError = exported('InvalidLocaleError');

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

/** Groups an unsigned digit string in threes with commas, the en-US way. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

describe('formatMoney acceptance', () => {
  it('1234567 USDC at Celo scale 6 formats as 1.23 in en-US', () => {
    expect(formatMoney(money(1_234_567n, 'USDC', 6), { locale: 'en-US' })).toBe(`1.23${NBSP}USDC`);
  });

  it('9007199254740993.01 USD formats without precision loss', () => {
    // 2^53 + 1 cannot be held by a number; it would print as ...992.
    expect(formatMoney(money(900719925474099301n, 'USD', 2), { locale: 'en-US' })).toBe(
      '$9,007,199,254,740,993.01',
    );
  });

  it('formats NGN in en-NG, KES in en-KE and BRL in pt-BR', () => {
    expect(formatMoney(money(2_000_000n, 'NGN', 2), { locale: 'en-NG' })).toBe('₦20,000.00');
    expect(formatMoney(money(150_000n, 'KES', 2), { locale: 'en-KE' })).toBe(`KSh${NBSP}1,500.00`);
    expect(formatMoney(money(123_456n, 'BRL', 2), { locale: 'pt-BR' })).toBe(`R$${NBSP}1.234,56`);
  });
});

describe('brand symbols in each home locale', () => {
  const cases: [CurrencyCode, string, string][] = [
    ['NGN', 'en-NG', '₦1,234,567.89'],
    ['KES', 'en-KE', `KSh${NBSP}1,234,567.89`],
    ['GHS', 'en-GH', 'GH₵1,234,567.89'],
    ['ZAR', 'en-ZA', `R${NBSP}1${NBSP}234${NBSP}567,89`],
    ['PHP', 'en-PH', '₱1,234,567.89'],
    ['INR', 'en-IN', '₹12,34,567.89'],
    ['BRL', 'pt-BR', `R$${NBSP}1.234.567,89`],
    ['COP', 'es-CO', `$${NBSP}1.234.567,89`],
    ['MXN', 'es-MX', '$1,234,567.89'],
    ['USD', 'en-US', '$1,234,567.89'],
    ['EUR', 'de-DE', `1.234.567,89${NBSP}€`],
    ['GBP', 'en-GB', '£1,234,567.89'],
  ];

  it.each(cases)('%s in %s is %s', (currency, locale, expected) => {
    expect(formatMoney(money(123_456_789n, currency, 2), { locale })).toBe(expected);
  });

  it('keeps the brand symbol outside the home locale', () => {
    expect(formatMoney(money(100n, 'NGN', 2), { locale: 'en-US' })).toBe('₦1.00');
    expect(formatMoney(money(150_000n, 'KES', 2), { locale: 'en-US' })).toBe(`KSh${NBSP}1,500.00`);
    expect(formatMoney(money(150n, 'USD', 2), { locale: 'en-NG' })).toBe('$1.50');
  });

  it('shows KSh, never Ksh or KES, for a negative amount too', () => {
    const s = formatMoney(money(-150_000n, 'KES', 2), { locale: 'en-KE' });
    expect(s).toBe(`${MINUS}KSh${NBSP}1,500.00`);
  });
});

describe('display scale', () => {
  it('always shows two decimals for fiat, whatever the stored scale', () => {
    expect(formatMoney(money(20_000n, 'NGN', 0), { locale: 'en-NG' })).toBe('₦20,000.00');
    expect(formatMoney(money(200_000_005n, 'NGN', 4), { locale: 'en-NG' })).toBe('₦20,000.00');
    expect(formatMoney(money(5n, 'USD', 1), { locale: 'en-US' })).toBe('$0.50');
  });

  it('rounds half-even by default', () => {
    expect(formatMoney(money(1005n, 'USD', 3), { locale: 'en-US' })).toBe('$1.00');
    expect(formatMoney(money(1015n, 'USD', 3), { locale: 'en-US' })).toBe('$1.02');
    expect(formatMoney(money(1_225_000n, 'USDC', 6), { locale: 'en-US' })).toBe(`1.22${NBSP}USDC`);
  });

  it('applies an explicit rounding mode', () => {
    const m = money(200_000_005n, 'NGN', 4);
    expect(formatMoney(m, { locale: 'en-NG', rounding: 'ceil' })).toBe('₦20,000.01');
    expect(formatMoney(m, { locale: 'en-NG', rounding: 'floor' })).toBe('₦20,000.00');
    expect(formatMoney(money(1005n, 'USD', 3), { locale: 'en-US', rounding: 'half-up' })).toBe(
      '$1.01',
    );
    expect(formatMoney(money(1_234_567n, 'USDC', 6), { locale: 'en-US', rounding: 'ceil' })).toBe(
      `1.24${NBSP}USDC`,
    );
  });

  it('formats Stellar USDC at scale 7 and USDm at scale 18', () => {
    expect(formatMoney(money(12_345_678n, 'USDC', 7), { locale: 'en-US' })).toBe(`1.23${NBSP}USDC`);
    const usdm = money(1_234_005n * 10n ** 15n, 'USDm', 18);
    expect(formatMoney(usdm, { locale: 'en-US' })).toBe(`1,234.00${NBSP}USDm`);
    expect(formatMoney(usdm, { locale: 'en-US', rounding: 'half-up' })).toBe(`1,234.01${NBSP}USDm`);
  });

  it('groups token amounts the locale way', () => {
    expect(formatMoney(money(1_234_567_890_000n, 'USDC', 6), { locale: 'pt-BR' })).toBe(
      `1.234.567,89${NBSP}USDC`,
    );
  });
});

describe('signs and extremes', () => {
  it('prints a negative amount with a minus sign', () => {
    expect(formatMoney(money(-150n, 'USD', 2), { locale: 'en-US' })).toBe(`${MINUS}$1.50`);
  });

  it('never prints a negative zero', () => {
    expect(formatMoney(money(-4n, 'USD', 3), { locale: 'en-US' })).toBe('$0.00');
    expect(formatMoney(money(-5n, 'USD', 3), { locale: 'en-US' })).toBe('$0.00');
    expect(formatMoney(money(-1n, 'USDC', 6), { locale: 'en-US' })).toBe(`0.00${NBSP}USDC`);
    expect(formatMoney(money(-5n, 'USD', 3), { locale: 'en-US', rounding: 'half-up' })).toBe(
      `${MINUS}$0.01`,
    );
  });

  it('keeps every digit of I128_MAX and I128_MIN', () => {
    const maxDigits = MAX.toString();
    const minDigits = (-MIN).toString();
    expect(formatMoney(money(MAX, 'USD', 2), { locale: 'en-US' })).toBe(
      `$${group(maxDigits.slice(0, -2))}.${maxDigits.slice(-2)}`,
    );
    expect(formatMoney(money(MIN, 'USD', 2), { locale: 'en-US' })).toBe(
      `${MINUS}$${group(minDigits.slice(0, -2))}.${minDigits.slice(-2)}`,
    );
    expect(formatMoney(money(MAX, 'USD', 0), { locale: 'en-US' })).toBe(`$${group(maxDigits)}.00`);
  });
});

describe('digits are always ASCII', () => {
  it.each(['ar-EG', 'en-US-u-nu-arab', 'hi-IN-u-nu-deva', 'fa-IR', 'bn-BD'])(
    'uses latn digits in %s',
    (locale) => {
      const s = formatMoney(money(123_456_789n, 'NGN', 2), { locale });
      expect(s.replace(/[0-9]/g, '')).not.toMatch(/\p{Nd}/u);
      expect(s).toContain('567');
      expect(s).toContain('₦');
    },
  );
});

describe('formatMoney rejects bad input', () => {
  it('rejects missing or malformed options and locales', () => {
    const m = money(100n, 'USD', 2);
    const bad: unknown[] = [
      undefined,
      null,
      'en-US',
      {},
      { locale: undefined },
      { locale: null },
      { locale: 1 },
      { locale: ['en-US'] },
      { locale: Object('en-US') as unknown },
      { locale: '' },
      { locale: '!!' },
      { locale: 'en_US' },
      { locale: 'en-US\n' },
    ];
    for (const options of bad) {
      expectMoneyError(() => formatMoney(m, loose(options)), InvalidLocaleError);
    }
  });

  it('never calls toString on a locale and keeps it out of the message', () => {
    const calls: string[] = [];
    const hostile = {
      toString() {
        calls.push('toString');
        return 'en-US';
      },
      [Symbol.toPrimitive]() {
        calls.push('toPrimitive');
        return 'en-US';
      },
    };
    expectMoneyError(
      () => formatMoney(money(1n, 'USD', 2), loose({ locale: hostile })),
      InvalidLocaleError,
    );
    expect(calls).toEqual([]);
    const err = expectMoneyError(
      () => formatMoney(money(1n, 'USD', 2), { locale: 'x\nlevel=info msg=paid' }),
      InvalidLocaleError,
    );
    expect(err.message).not.toContain('msg=paid');
    expect(err.message.length).toBeLessThanOrEqual(200);
    expect(err.message).not.toMatch(/[\r\n]/);
  });

  it('rejects a bad rounding mode after the locale', () => {
    const m = money(100n, 'USD', 2);
    for (const rounding of [null, 'HALF_EVEN', 'round', '', 0]) {
      expectMoneyError(
        () => formatMoney(m, loose({ locale: 'en-US', rounding })),
        InvalidRoundingModeError,
      );
    }
    expectMoneyError(
      () => formatMoney(m, loose({ locale: '!!', rounding: 'bogus' })),
      InvalidLocaleError,
    );
  });

  const forged: [string, unknown, ErrorClass][] = [
    ['null', null, InvalidAmountError],
    ['a number amount', { amount: 1, currency: 'USD', scale: 2 }, InvalidAmountError],
    ['an unknown currency', { amount: 1n, currency: 'BTC', scale: 2 }, UnknownCurrencyError],
    ['a negative scale', { amount: 1n, currency: 'USD', scale: -1 }, InvalidScaleError],
    ['an out of range amount', { amount: MAX + 1n, currency: 'USD', scale: 2 }, MoneyOverflowError],
  ];

  it.each(forged)('rejects a forged operand with %s before the options', (_l, value, Expected) => {
    expectMoneyError(() => formatMoney(loose(value), { locale: 'en-US' }), Expected);
    expectMoneyError(() => formatMoney(loose(value), loose(null)), Expected);
  });

  it('reads each operand field and each option once', () => {
    const reads = { amount: 0, currency: 0, scale: 0, locale: 0, rounding: 0 };
    const answers: Record<keyof typeof reads, unknown[]> = {
      amount: [123_456n, 1n],
      currency: ['KES', 'BTC'],
      scale: [2, 19],
      locale: ['en-KE', '!!'],
      rounding: ['half-even', 'bogus'],
    };
    const counted = (keys: (keyof typeof reads)[]): unknown =>
      new Proxy(
        {},
        {
          get(_target, key) {
            const k = keys.find((name) => name === key);
            if (k === undefined) return undefined;
            reads[k] += 1;
            const list = answers[k];
            return list[Math.min(reads[k], list.length) - 1];
          },
        },
      );
    const value = counted(['amount', 'currency', 'scale']);
    const options = counted(['locale', 'rounding']);
    expect(formatMoney(loose(value), loose(options))).toBe(`KSh${NBSP}1,234.56`);
    for (const n of Object.values(reads)) expect(n).toBeLessThanOrEqual(1);
  });

  it('is deterministic and does not mutate its input', () => {
    const m = money(123_456_789n, 'GHS', 2);
    const a = formatMoney(m, { locale: 'en-GH' });
    const b = formatMoney(m, { locale: 'en-GH' });
    expect(a).toBe(b);
    expect(m).toEqual(money(123_456_789n, 'GHS', 2));
  });
});

// The currencyCode option and its contract are documented in dollar-sign.test.ts.
describe('currency code for ambiguous dollar signs', () => {
  const InvalidFormatOptionError = exported('InvalidFormatOptionError');
  const ambiguous = { currencyCode: 'whenAmbiguous' } as const;

  it('COP and MXN show their code when ambiguous', () => {
    expect(formatMoney(money(150_000n, 'COP', 2), { locale: 'en-US', ...ambiguous })).toBe(
      `$1,500.00${NBSP}COP`,
    );
    expect(formatMoney(money(150_000n, 'MXN', 2), { locale: 'es-MX', ...ambiguous })).toBe(
      `$1,500.00${NBSP}MXN`,
    );
    expect(formatMoney(money(150_000n, 'USD', 2), { locale: 'en-US', ...ambiguous })).toBe(
      `$1,500.00${NBSP}USD`,
    );
    expect(formatMoney(money(123_456n, 'COP', 2), { locale: 'es-CO', ...ambiguous })).toBe(
      `$${NBSP}1.234,56${NBSP}COP`,
    );
  });

  it('NGN and USDC are unchanged when ambiguous', () => {
    expect(formatMoney(money(2_000_000n, 'NGN', 2), { locale: 'en-NG', ...ambiguous })).toBe(
      '₦20,000.00',
    );
    expect(formatMoney(money(1_234_567n, 'USDC', 6), { locale: 'en-US', ...ambiguous })).toBe(
      `1.23${NBSP}USDC`,
    );
    for (const currency of ['KES', 'GHS', 'ZAR', 'PHP', 'INR', 'BRL', 'EUR', 'GBP'] as const) {
      const m = money(123_456n, currency, 2);
      expect(formatMoney(m, { locale: 'en-US', ...ambiguous })).toBe(
        formatMoney(m, { locale: 'en-US' }),
      );
    }
    const usdm = money(1_234n * 10n ** 18n, 'USDm', 18);
    expect(formatMoney(usdm, { locale: 'en-US', ...ambiguous })).toBe(
      formatMoney(usdm, { locale: 'en-US' }),
    );
  });

  it('never appends the code by default or with never', () => {
    const cop = money(150_000n, 'COP', 2);
    expect(formatMoney(cop, { locale: 'en-US' })).toBe('$1,500.00');
    expect(formatMoney(cop, { locale: 'en-US', currencyCode: 'never' })).toBe('$1,500.00');
  });

  it('appends the code after a negative amount and with any rounding', () => {
    expect(formatMoney(money(-150n, 'USD', 2), { locale: 'en-US', ...ambiguous })).toBe(
      `−$1.50${NBSP}USD`,
    );
    expect(
      formatMoney(money(1005n, 'MXN', 3), { locale: 'en-US', rounding: 'ceil', ...ambiguous }),
    ).toBe(`$1.01${NBSP}MXN`);
  });

  it('rejects any other currencyCode after the locale and rounding checks', () => {
    const m = money(100n, 'USD', 2);
    const values: unknown[] = ['always', 'WHEN_AMBIGUOUS', '', null, true, 1, Object('never')];
    for (const currencyCode of values) {
      expectMoneyError(
        () => formatMoney(m, loose({ locale: 'en-US', currencyCode })),
        InvalidFormatOptionError,
      );
    }
    expectMoneyError(
      () => formatMoney(m, loose({ locale: '!!', currencyCode: 'bogus' })),
      InvalidLocaleError,
    );
    expectMoneyError(
      () => formatMoney(m, loose({ locale: 'en-US', rounding: 'bogus', currencyCode: 'bogus' })),
      InvalidRoundingModeError,
    );
  });

  it('reads currencyCode at most once', () => {
    let reads = 0;
    const answers: unknown[] = ['whenAmbiguous', 'bogus'];
    const options = {
      locale: 'en-US',
      get currencyCode() {
        reads += 1;
        return answers[Math.min(reads, answers.length) - 1];
      },
    };
    expect(formatMoney(money(150n, 'COP', 2), loose(options))).toBe(`$1.50${NBSP}COP`);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('ignores a currencyCode inherited from Object.prototype', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto['currencyCode'] = 'whenAmbiguous';
    try {
      expect(formatMoney(money(150n, 'COP', 2), { locale: 'en-US' })).toBe('$1.50');
    } finally {
      delete proto['currencyCode'];
    }
  });
});
