// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Display typography is the same in every locale: the true minus sign
// (U+2212) and the plain no break space (U+00A0). ICU varies on both, for
// example fr-FR groups with U+202F and en-US uses an ASCII hyphen for minus.
// toDecimalString is for data, not display, so it stays plain ASCII.

import { describe, expect, it } from 'vitest';

import { formatMoney, formatTokenAmount } from './format.js';
import { money, moneyAt, tokenAmount } from './index.js';
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
// Each unit formats `whole` whole units (plus `extra` minor units) with the
// formatter for its kind, so fiat and tokens follow the same typography.
const UNITS: [string, (whole: bigint, locale: string) => string][] = [
  ['USD', (w, locale) => formatMoney(money(w * 100n, 'USD'), { locale })],
  ['EUR', (w, locale) => formatMoney(money(w * 100n, 'EUR'), { locale })],
  ['KES', (w, locale) => formatMoney(moneyAt(w * 10n ** 6n, 'KES', 6), { locale })],
  [
    'USDC',
    (w, locale) => formatTokenAmount(tokenAmount(w * 10n ** 6n, 'USDC', 'celo'), { locale }),
  ],
  [
    'USDm',
    (w, locale) => formatTokenAmount(tokenAmount(w * 10n ** 18n, 'USDm', 'celo'), { locale }),
  ],
];

describe('formatMoney minus sign', () => {
  it.each(LOCALES)(
    'uses U+2212 and never an ASCII hyphen for a negative amount in %s',
    (locale) => {
      for (const [, format] of UNITS) {
        const s = format(-1234n, locale);
        expect(s).toContain(MINUS);
        expect(s).not.toContain('-');
      }
    },
  );

  it('keeps sv-SE and fa-IR, which already use U+2212, unchanged in shape', () => {
    expect(formatMoney(money(-150n, 'EUR'), { locale: 'sv-SE' })).toBe(`${MINUS}1,50${NBSP}\u20ac`);
  });

  it('prints U+2212 for en-US', () => {
    expect(formatMoney(money(-150n, 'USD'), { locale: 'en-US' })).toBe(`${MINUS}$1.50`);
    expect(formatTokenAmount(tokenAmount(-1_234_567n, 'USDC', 'celo'), { locale: 'en-US' })).toBe(
      `${MINUS}1.23${NBSP}USDC`,
    );
  });

  it('never prints any minus for a value that rounds to zero', () => {
    for (const locale of LOCALES) {
      const s = formatMoney(moneyAt(-4n, 'USD', 3), { locale });
      expect(s).not.toMatch(/[-\u2212]/);
    }
  });
});

describe('formatMoney spaces', () => {
  it('groups fr-FR with U+00A0, not U+202F', () => {
    expect(formatMoney(money(123_456_789n, 'EUR'), { locale: 'fr-FR' })).toBe(
      `1${NBSP}234${NBSP}567,89${NBSP}\u20ac`,
    );
    expect(
      formatTokenAmount(tokenAmount(1_234_567_890_000n, 'USDC', 'celo'), { locale: 'fr-FR' }),
    ).toBe(`1${NBSP}234${NBSP}567,89${NBSP}USDC`);
  });

  it.each(LOCALES)('never contains U+202F in %s', (locale) => {
    for (const [, format] of UNITS) {
      for (const sign of [1n, -1n]) {
        expect(format(sign * 123_456_789n, locale)).not.toContain(NNBSP);
      }
    }
  });
});

describe('toDecimalString stays ASCII for data', () => {
  it('uses an ASCII hyphen minus and no spaces', () => {
    expect(toDecimalString(money(-5n, 'USD'))).toBe('-0.05');
    expect(toDecimalString(money(-123_456_789n, 'EUR'))).toBe('-1234567.89');
    expect(toDecimalString(money(-123_456_789n, 'EUR'))).not.toContain(MINUS);
  });
});
