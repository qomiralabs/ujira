// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { FIAT_CURRENCIES, TOKEN_DISPLAY_SCALE } from './currencies.js';
import type { FiatCurrencyCode } from './currencies.js';
import { InvalidLocaleError } from './errors.js';
import { multiply } from './money.js';
import type { Money } from './money.js';
import { readOption } from './options.js';
import { toDecimalString } from './parse.js';
import { parseRoundingMode, rescale } from './rescale.js';
import type { RoundingMode } from './rescale.js';

// The symbol is part of the brand, so it stays the same in every locale.
// Only its position and the digit grouping follow the locale.
const BRAND_SYMBOLS: Readonly<Record<FiatCurrencyCode, string>> = Object.freeze({
  USD: '$',
  NGN: '₦',
  KES: 'KSh',
  GHS: 'GH₵',
  ZAR: 'R',
  PHP: '₱',
  INR: '₹',
  BRL: 'R$',
  COP: '$',
  MXN: '$',
  EUR: '€',
  GBP: '£',
});

const NBSP = '\u00a0';

const MAX_LOCALE_LENGTH = 64;

function readLocale(options: unknown): { locale: string; rounding: unknown } {
  if (typeof options !== 'object' || options === null) {
    throw new InvalidLocaleError('options with a locale are required');
  }
  const locale = readOption(options, 'locale');
  const rounding = readOption(options, 'rounding');
  if (typeof locale !== 'string' || locale === '') {
    throw new InvalidLocaleError('locale must be a non empty language tag');
  }
  // Intl spends seconds on a megabyte tag before rejecting it, so length is
  // checked first. Real tags, extensions included, fit easily.
  if (locale.length > MAX_LOCALE_LENGTH) {
    throw new InvalidLocaleError(`locale must be at most ${String(MAX_LOCALE_LENGTH)} characters`);
  }
  try {
    Intl.getCanonicalLocales(locale);
  } catch {
    // The tag itself never goes into the message, it is caller text.
    throw new InvalidLocaleError('locale is not a valid language tag');
  }
  return { locale, rounding };
}

/** Decimal string at exactly `displayScale` places, padded rather than rescaled up. */
function displayDecimal(value: Money, displayScale: number, mode: RoundingMode): string {
  if (value.scale >= displayScale) {
    return toDecimalString(rescale(value, displayScale, mode));
  }
  // Padding the text instead of multiplying means a valid Money can never
  // overflow on the way to the screen.
  const [whole = '', fraction = ''] = toDecimalString(value).split('.');
  return `${whole}.${fraction.padEnd(displayScale, '0')}`;
}

/**
 * Formats `m` for people in `options.locale`.
 *
 * The value is rescaled to the display scale (two places for every launch
 * currency and token) with `options.rounding`, which defaults to half-even.
 * The exact decimal string is handed to Intl.NumberFormat, so no JavaScript
 * number is formed and every digit of an i128 amount survives. Digits are
 * always ASCII. Fiat uses the brand symbol (KES shows KSh); tokens print the
 * locale's decimal format followed by a no break space and the asset code.
 *
 * The result is for display only. Right to left locales can include bidi
 * control marks, so never parse it back, compare it or store it as data.
 * Locales longer than 64 characters throw InvalidLocaleError before Intl is
 * called, and option values inherited from Object.prototype are ignored.
 */
export function formatMoney(
  m: Money,
  options: { locale: string; rounding?: RoundingMode },
): string {
  const value = multiply(m, 1n);
  const { locale, rounding } = readLocale(options);
  const mode = rounding === undefined ? 'half-even' : parseRoundingMode(rounding);

  const fiat = FIAT_CURRENCIES.find((c) => c.code === value.currency);
  const displayScale = fiat === undefined ? TOKEN_DISPLAY_SCALE : fiat.minorUnits;
  // Intl reads a numeric string as an exact decimal; the cast only satisfies
  // the type, the value stays a string.
  const text = displayDecimal(value, displayScale, mode) as `${number}`;
  const digits = { minimumFractionDigits: displayScale, maximumFractionDigits: displayScale };

  if (fiat === undefined) {
    const formatted = new Intl.NumberFormat(locale, { ...digits, numberingSystem: 'latn' }).format(
      text,
    );
    return `${formatted}${NBSP}${value.currency}`;
  }
  const symbol = BRAND_SYMBOLS[fiat.code];
  return new Intl.NumberFormat(locale, {
    ...digits,
    style: 'currency',
    currency: fiat.code,
    currencyDisplay: 'narrowSymbol',
    numberingSystem: 'latn',
  })
    .formatToParts(text)
    .map((part) => (part.type === 'currency' ? symbol : part.value))
    .join('');
}
