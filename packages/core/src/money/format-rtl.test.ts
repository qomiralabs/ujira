// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the ISO code appended with currencyCode: 'whenAmbiguous' in
 * right to left locales (format.ts).
 *
 * In a locale whose text direction is right to left (Intl.Locale text info),
 * the appended code is written as U+00A0, then U+2068 (first strong
 * isolate), the ISO code, and U+2069 (pop directional isolate). The isolate
 * keeps the Latin code from pulling the "$" and the digits around, so a
 * positive and a negative amount lay out the same way. Left to right
 * locales get exactly the output they had before: no isolate characters.
 * Nothing else changes: without the option, or for a currency that does
 * not print "$", right to left output has no isolates either.
 */

import { describe, expect, it } from 'vitest';

import { formatMoney } from './format.js';
import { money } from './index.js';

const NBSP = '\u00a0';
const FSI = '\u2068';
const PDI = '\u2069';
const MINUS = '\u2212';
const ambiguous = { currencyCode: 'whenAmbiguous' } as const;

// Bidi controls that ICU or this module may place around the number.
const BIDI_CONTROLS = /[\u200e\u200f\u061c\u2066-\u2069]/g;

describe('the appended code in right to left locales', () => {
  it.each(['ar-EG', 'ur-PK'])(
    'isolates the code for a positive and a negative COP amount in %s',
    (locale) => {
      const positive = formatMoney(money(150_000n, 'COP', 2), { locale, ...ambiguous });
      const negative = formatMoney(money(-150_000n, 'COP', 2), { locale, ...ambiguous });
      for (const s of [positive, negative]) {
        expect(s.endsWith(`${NBSP}${FSI}COP${PDI}`)).toBe(true);
        expect(s.match(/\u2068/g)).toHaveLength(1);
        expect(s.match(/\u2069/g)).toHaveLength(1);
      }
      // Same layout: the negative is the positive plus a minus sign and marks.
      expect(negative.replace(BIDI_CONTROLS, '').replace(MINUS, '')).toBe(
        positive.replace(BIDI_CONTROLS, ''),
      );
    },
  );

  it('isolates the code for every dollar currency in a right to left locale', () => {
    for (const currency of ['USD', 'COP', 'MXN'] as const) {
      const s = formatMoney(money(-150n, currency, 2), { locale: 'he-IL', ...ambiguous });
      expect(s.endsWith(`${NBSP}${FSI}${currency}${PDI}`)).toBe(true);
    }
  });

  it('adds no isolates without the option or for a currency without "$"', () => {
    for (const locale of ['ar-EG', 'ur-PK', 'fa-IR', 'he-IL']) {
      const plain = formatMoney(money(-150_000n, 'COP', 2), { locale });
      expect(plain).not.toMatch(/[\u2068\u2069]/);
      const never = formatMoney(money(-150_000n, 'COP', 2), { locale, currencyCode: 'never' });
      expect(never).toBe(plain);
      const naira = formatMoney(money(-150_000n, 'NGN', 2), { locale, ...ambiguous });
      expect(naira).toBe(formatMoney(money(-150_000n, 'NGN', 2), { locale }));
    }
  });
});

describe('left to right output is unchanged', () => {
  it.each(['en-US', 'en-NG', 'es-CO', 'es-MX', 'pt-BR', 'de-DE', 'fr-FR'])(
    'appends the code without isolates in %s',
    (locale) => {
      for (const amount of [150_000n, -150_000n]) {
        const m = money(amount, 'COP', 2);
        const s = formatMoney(m, { locale, ...ambiguous });
        expect(s).not.toMatch(/[\u2068\u2069]/);
        expect(s).toBe(`${formatMoney(m, { locale })}${NBSP}COP`);
      }
    },
  );

  it('keeps the exact en-US bytes', () => {
    expect(formatMoney(money(-150n, 'USD', 2), { locale: 'en-US', ...ambiguous })).toBe(
      `${MINUS}$1.50${NBSP}USD`,
    );
  });
});
