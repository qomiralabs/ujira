// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Display typography is the same in every locale: the true minus sign
// (U+2212) and the plain no break space (U+00A0). ICU varies on both, for
// example fr-FR groups with U+202F and en-US uses an ASCII hyphen for minus.
// toDecimalString is for data, not display, so it stays plain ASCII.

import { describe, expect, it } from 'vitest';

import { formatMoney } from './format.js';
import { money } from './index.js';
import type { CurrencyCode } from './index.js';
import { toDecimalString } from './parse.js';

const NBSP = '\u00a0';
const NNBSP = '\u202f';
const MINUS = '\u2212';

const LOCALES = [
  'en-US',
  'en-NG',
  'en-KE',
  'pt-BR',
  'es-CO',
  'de-DE',
  'fr-FR',
  'sv-SE',
  'fa-IR',
  'ar-EG',
  'he-IL',
  'en-IN',
];
const UNITS: [CurrencyCode, number][] = [
  ['USD', 2],
  ['EUR', 2],
  ['KES', 2],
  ['USDC', 6],
  ['USDm', 18],
];

describe('formatMoney minus sign', () => {
  it.each(LOCALES)(
    'uses U+2212 and never an ASCII hyphen for a negative amount in %s',
    (locale) => {
      for (const [currency, scale] of UNITS) {
        const s = formatMoney(money(-(10n ** BigInt(scale)) * 1234n, currency, scale), { locale });
        expect(s).toContain(MINUS);
        expect(s).not.toContain('-');
      }
    },
  );

  it('keeps sv-SE and fa-IR, which already use U+2212, unchanged in shape', () => {
    expect(formatMoney(money(-150n, 'EUR', 2), { locale: 'sv-SE' })).toBe(
      `${MINUS}1,50${NBSP}\u20ac`,
    );
  });

  it('prints U+2212 for en-US', () => {
    expect(formatMoney(money(-150n, 'USD', 2), { locale: 'en-US' })).toBe(`${MINUS}$1.50`);
    expect(formatMoney(money(-1_234_567n, 'USDC', 6), { locale: 'en-US' })).toBe(
      `${MINUS}1.23${NBSP}USDC`,
    );
  });

  it('never prints any minus for a value that rounds to zero', () => {
    for (const locale of LOCALES) {
      const s = formatMoney(money(-4n, 'USD', 3), { locale });
      expect(s).not.toMatch(/[-\u2212]/);
    }
  });
});

describe('formatMoney spaces', () => {
  it('groups fr-FR with U+00A0, not U+202F', () => {
    expect(formatMoney(money(123_456_789n, 'EUR', 2), { locale: 'fr-FR' })).toBe(
      `1${NBSP}234${NBSP}567,89${NBSP}\u20ac`,
    );
    expect(formatMoney(money(1_234_567_890_000n, 'USDC', 6), { locale: 'fr-FR' })).toBe(
      `1${NBSP}234${NBSP}567,89${NBSP}USDC`,
    );
  });

  it.each(LOCALES)('never contains U+202F in %s', (locale) => {
    for (const [currency, scale] of UNITS) {
      for (const sign of [1n, -1n]) {
        const amount = sign * 123_456_789n * 10n ** BigInt(scale);
        expect(formatMoney(money(amount, currency, scale), { locale })).not.toContain(NNBSP);
      }
    }
  });
});

describe('toDecimalString stays ASCII for data', () => {
  it('uses an ASCII hyphen minus and no spaces', () => {
    expect(toDecimalString(money(-5n, 'USD', 2))).toBe('-0.05');
    expect(toDecimalString(money(-123_456_789n, 'EUR', 2))).toBe('-1234567.89');
    expect(toDecimalString(money(-123_456_789n, 'EUR', 2))).not.toContain(MINUS);
  });
});
