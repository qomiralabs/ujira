// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { TOKEN_DISPLAY_SCALE } from './currencies.js';
import type { FiatCurrencyCode } from './currencies.js';
import { InvalidLocaleError } from './errors.js';
import { minorUnits, powerOfTen, snapshotFiat, snapshotToken } from './money.js';
import type { Money, TokenAmount } from './money.js';
import { isPlainRecord, readOwnField } from './options.js';
import { decimalText } from './parse.js';
import { divideRounded, parseRoundingMode } from './rescale.js';
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
const NARROW_NBSP = '\u202f';
const MINUS = '\u2212';

const MAX_LOCALE_LENGTH = 64;

function readLocale(options: unknown): { locale: string; rounding: unknown } {
  if (!isPlainRecord(options)) {
    throw new InvalidLocaleError('options with a locale are required');
  }
  const locale = readOwnField(options, 'locale');
  const rounding = readOwnField(options, 'rounding');
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

/**
 * Decimal string of `amount` units of 10^-scale at exactly `displayScale`
 * places. Every fiat and token scale is at least its display scale, so this
 * only ever rounds down in precision, never multiplies, and a valid value
 * can never overflow on the way to the screen.
 */
function displayDecimal(
  amount: bigint,
  scale: number,
  displayScale: number,
  mode: RoundingMode,
): `${number}` {
  const shifted = divideRounded(amount, powerOfTen(scale) / powerOfTen(displayScale), mode);
  // Intl reads a numeric string as an exact decimal; the cast only satisfies
  // the type, the value stays a string.
  return decimalText(shifted, displayScale) as `${number}`;
}

function readFormatOptions(options: unknown): { locale: string; mode: RoundingMode } {
  const { locale, rounding } = readLocale(options);
  const mode = rounding === undefined ? 'half-even' : parseRoundingMode(rounding);
  return { locale, mode };
}

/**
 * Joins Intl parts with one house style for every locale: the brand symbol,
 * the true minus sign U+2212, and U+00A0 where ICU uses U+202F (fr-FR
 * grouping). Bidi marks around the minus are kept, only the hyphen changes.
 */
function typeset(parts: readonly Intl.NumberFormatPart[], symbol: string): string {
  return parts
    .map((part) => {
      if (part.type === 'currency') return symbol;
      if (part.type === 'minusSign') return part.value.replaceAll('-', MINUS);
      return part.value.replaceAll(NARROW_NBSP, NBSP);
    })
    .join('');
}

/**
 * Formats fiat `m` for people in `options.locale`.
 *
 * The value is rounded to the currency's minor unit (two places for every
 * launch currency) with `options.rounding`, which defaults to half-even. The
 * exact decimal string is handed to Intl.NumberFormat, so no JavaScript
 * number is formed and every digit of an i128 amount survives. Digits are
 * always ASCII and the brand symbol never depends on the locale (KES shows
 * KSh). A token amount throws KindMismatchError; use formatTokenAmount.
 *
 * Negative amounts use the true minus sign U+2212 and spaces are always
 * U+00A0, whatever the locale. toDecimalString stays ASCII for data.
 *
 * The result is for display only. Right to left locales can include bidi
 * control marks, so never parse it back, compare it or store it as data.
 * Locales longer than 64 characters throw InvalidLocaleError before Intl is
 * called, and option bags must be plain objects whose values come from their own fields.
 */
export function formatMoney(
  m: Money,
  options: { locale: string; rounding?: RoundingMode },
): string {
  const value = snapshotFiat(m);
  const { locale, mode } = readFormatOptions(options);
  const displayScale = minorUnits(value.currency);
  const parts = new Intl.NumberFormat(locale, {
    minimumFractionDigits: displayScale,
    maximumFractionDigits: displayScale,
    style: 'currency',
    currency: value.currency,
    currencyDisplay: 'narrowSymbol',
    numberingSystem: 'latn',
  }).formatToParts(displayDecimal(value.amount, value.scale, displayScale, mode));
  return typeset(parts, BRAND_SYMBOLS[value.currency]);
}

/**
 * Formats token amount `t` for people in `options.locale`: the locale's
 * decimal format at the token display scale (two places), a no break space
 * and the asset code, for example "1.23 USDC". The chain is never shown.
 * Rounding, digits, minus sign, spaces and option handling follow
 * formatMoney. Fiat money throws KindMismatchError; use formatMoney.
 */
export function formatTokenAmount(
  t: TokenAmount,
  options: { locale: string; rounding?: RoundingMode },
): string {
  const value = snapshotToken(t);
  const { locale, mode } = readFormatOptions(options);
  const parts = new Intl.NumberFormat(locale, {
    minimumFractionDigits: TOKEN_DISPLAY_SCALE,
    maximumFractionDigits: TOKEN_DISPLAY_SCALE,
    numberingSystem: 'latn',
  }).formatToParts(displayDecimal(value.amount, value.scale, TOKEN_DISPLAY_SCALE, mode));
  return `${typeset(parts, '')}${NBSP}${value.asset}`;
}
