// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import {
  FIAT_CURRENCIES,
  I128_MAX,
  I128_MIN,
  formatMoney as coreFormatMoney,
  dollarSignAmbiguous,
  money,
} from '@ujira/core';
import type { FiatCurrencyCode } from '@ujira/core';
import { cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { AmountProvider } from './amount-context.js';
import { Amount } from './amount.js';

afterEach(cleanup);

// The launch corridors' locales, the right to left ones that change where
// the sign and the code go, and one with a non breaking group separator.
const LOCALES = [
  'en',
  'en-NG',
  'en-KE',
  'en-GH',
  'en-IN',
  'fr-FR',
  'pt-BR',
  'es-CO',
  'es-MX',
  'sw-KE',
  'yo-NG',
  'ha-NG',
  'ig-NG',
  'ar',
  'ar-EG',
  'he',
];

const CODES = FIAT_CURRENCIES.map((currency) => currency.code);

// Corridor sets with and without two dollar currencies, so both code displays
// are drawn.
const CORRIDORS: readonly (readonly FiatCurrencyCode[] | undefined)[] = [
  undefined,
  ['NGN', 'KES'],
  ['USD', 'NGN'],
  ['USD', 'COP'],
  ['MXN', 'COP', 'BRL'],
];

// Mostly everyday sizes, with the full signed 128 bit range mixed in.
const minorUnits = fc.oneof(
  fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
  fc.bigInt({ min: I128_MIN, max: I128_MAX }),
);

describe('Amount against the core formatter', () => {
  it('the rendered text equals core formatMoney for random minor units, currencies and locales', () => {
    fc.assert(
      fc.property(
        minorUnits,
        fc.constantFrom(...CODES),
        fc.constantFrom(...LOCALES),
        fc.constantFrom(...CORRIDORS),
        fc.boolean(),
        (minor, currency, locale, corridors, asString) => {
          const currencyCode =
            corridors !== undefined && dollarSignAmbiguous(corridors) ? 'whenAmbiguous' : 'never';
          const expected = coreFormatMoney(money(minor, currency), { locale, currencyCode });
          const { container, unmount } = render(
            <AmountProvider
              locale={locale}
              {...(corridors === undefined ? {} : { corridorCurrencies: corridors })}
            >
              <Amount minor={asString ? minor.toString() : minor} currency={currency} />
            </AmountProvider>,
          );
          const text = container.querySelector('[data-slot="amount-value"]')?.textContent;
          unmount();
          expect(text).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
    // Each run mounts a React tree in jsdom, which is slow on a loaded runner.
  }, 120_000);
});
