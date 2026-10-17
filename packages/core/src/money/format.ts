// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { FIAT_CURRENCIES, TOKEN_DISPLAY_SCALE, isCurrencyCode } from './currencies.js';
import type { CurrencyCode, FiatCurrencyCode } from './currencies.js';
import { InvalidFormatOptionError, InvalidLocaleError, UnknownCurrencyError } from './errors.js';
import { multiply } from './money.js';
import type { Money } from './money.js';
import { isPlainRecord, readOwnField } from './options.js';
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

const DOLLAR_SIGN = '$';

// First strong isolate and pop directional isolate. Wrapped around the
// appended code in right to left text so the Latin letters keep to
// themselves and cannot move the "$" or the digits around them.
const FSI = '\u2068';
const PDI = '\u2069';

// Scripts written right to left, for engines that cannot report a locale's
// direction themselves.
const RTL_SCRIPTS: ReadonlySet<unknown> = new Set<unknown>([
  'Arab',
  'Hebr',
  'Thaa',
  'Syrc',
  'Nkoo',
  'Adlm',
  'Mand',
  'Samr',
  'Rohg',
]);

// Text info is newer than Intl.Locale itself: some engines have only the
// older textInfo accessor and some have neither, and the TypeScript library
// declares neither yet, so both are optional here.
interface LocaleTextInfo {
  getTextInfo?: () => { direction?: string };
  readonly textInfo?: { direction?: string };
}

function reportedDirection(locale: Intl.Locale): string | undefined {
  const info = locale as unknown as LocaleTextInfo;
  if (typeof info.getTextInfo === 'function') return info.getTextInfo().direction;
  return info.textInfo?.direction;
}

/**
 * Whether `locale` (already validated) writes right to left: from the
 * engine's text info when it has any, otherwise from the locale's likely
 * script. The answer only decides whether the code is isolated, so if even
 * that lookup fails the amount is formatted left to right rather than not
 * at all.
 */
function isRightToLeft(locale: string): boolean {
  try {
    const parsed = new Intl.Locale(locale);
    const direction = reportedDirection(parsed);
    if (direction !== undefined) return direction === 'rtl';
    return RTL_SCRIPTS.has(parsed.maximize().script);
  } catch {
    return false;
  }
}

/**
 * Whether formatMoney follows a "$" amount with its ISO code. 'never' is the
 * default and today's output; 'whenAmbiguous' is for principal views whose
 * currencies include more than one "$" currency (see dollarSignAmbiguous).
 */
export type CurrencyCodeDisplay = 'never' | 'whenAmbiguous';

const CURRENCY_CODE_DISPLAYS: ReadonlySet<unknown> = new Set<unknown>(['never', 'whenAmbiguous']);

function parseCurrencyCodeDisplay(value: unknown): CurrencyCodeDisplay {
  if (value === undefined) return 'never';
  if (!CURRENCY_CODE_DISPLAYS.has(value)) {
    throw new InvalidFormatOptionError("currencyCode must be 'never' or 'whenAmbiguous'");
  }
  return value as CurrencyCodeDisplay;
}

/**
 * True when `currencies` holds two or more distinct fiat currencies printed
 * with "$" (USD, COP and MXN today), so their amounts cannot be told apart
 * by symbol. Principal views pass the currencies of the principal's
 * corridors and use the answer for every amount they show, so filtering a
 * table never changes the format. Recipient views never need it. Tokens
 * always print their asset code and never count.
 */
export function dollarSignAmbiguous(currencies: readonly CurrencyCode[]): boolean {
  const list: unknown = currencies;
  if (!Array.isArray(list)) {
    throw new InvalidFormatOptionError('currencies must be an array of currency codes');
  }
  const dollars = new Set<FiatCurrencyCode>();
  for (const index of list.keys()) {
    // Each entry is read once, and a hole is missing rather than inherited.
    const code: unknown = Object.hasOwn(list, index)
      ? (list as readonly unknown[])[index]
      : undefined;
    if (!isCurrencyCode(code)) {
      throw new UnknownCurrencyError('currencies must hold only known currency codes');
    }
    const fiat = FIAT_CURRENCIES.find((c) => c.code === code);
    if (fiat !== undefined && BRAND_SYMBOLS[fiat.code] === DOLLAR_SIGN) dollars.add(fiat.code);
  }
  return dollars.size >= 2;
}
const NARROW_NBSP = '\u202f';
const MINUS = '\u2212';

const MAX_LOCALE_LENGTH = 64;

function readLocale(options: unknown): {
  locale: string;
  rounding: unknown;
  currencyCode: unknown;
} {
  if (!isPlainRecord(options)) {
    throw new InvalidLocaleError('options with a locale are required');
  }
  const locale = readOwnField(options, 'locale');
  const rounding = readOwnField(options, 'rounding');
  const currencyCode = readOwnField(options, 'currencyCode');
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
  return { locale, rounding, currencyCode };
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
 * Formats `m` for people in `options.locale`.
 *
 * The value is rescaled to the display scale (two places for every launch
 * currency and token) with `options.rounding`, which defaults to half-even.
 * The exact decimal string is handed to Intl.NumberFormat, so no JavaScript
 * number is formed and every digit of an i128 amount survives. Digits are
 * always ASCII. Fiat uses the brand symbol (KES shows KSh); tokens print the
 * locale's decimal format followed by a no break space and the asset code.
 *
 * Negative amounts use the true minus sign U+2212 and spaces are always
 * U+00A0, whatever the locale. toDecimalString stays ASCII for data.
 *
 * With `options.currencyCode: 'whenAmbiguous'`, a fiat amount printed with
 * "$" (USD, COP, MXN) is followed by a no break space and its ISO code, for
 * example "$1,500.00 COP". The default, 'never', keeps the plain symbol.
 * Other currencies and tokens are never changed. Any other value throws
 * InvalidFormatOptionError after the locale and rounding checks. In right to
 * left locales the code sits between U+2068 and U+2069 so positive and
 * negative amounts lay out the same way; left to right output has no
 * isolate characters. Principal views decide once from their corridors:
 *
 *   const currencyCode = dollarSignAmbiguous(corridorCurrencies) ? 'whenAmbiguous' : 'never';
 *   formatMoney(amount, { locale, currencyCode });
 *
 * The result is for display only. Right to left locales can include bidi
 * control marks, so never parse it back, compare it or store it as data.
 * Locales longer than 64 characters throw InvalidLocaleError before Intl is
 * called, and option bags must be plain objects whose values come from their own fields.
 */
export function formatMoney(
  m: Money,
  options: { locale: string; rounding?: RoundingMode; currencyCode?: CurrencyCodeDisplay },
): string {
  const value = multiply(m, 1n);
  const { locale, rounding, currencyCode } = readLocale(options);
  const mode = rounding === undefined ? 'half-even' : parseRoundingMode(rounding);
  const codeDisplay = parseCurrencyCodeDisplay(currencyCode);

  const fiat = FIAT_CURRENCIES.find((c) => c.code === value.currency);
  const displayScale = fiat === undefined ? TOKEN_DISPLAY_SCALE : fiat.minorUnits;
  // Intl reads a numeric string as an exact decimal; the cast only satisfies
  // the type, the value stays a string.
  const text = displayDecimal(value, displayScale, mode) as `${number}`;
  const digits = { minimumFractionDigits: displayScale, maximumFractionDigits: displayScale };

  if (fiat === undefined) {
    const parts = new Intl.NumberFormat(locale, {
      ...digits,
      numberingSystem: 'latn',
    }).formatToParts(text);
    return `${typeset(parts, '')}${NBSP}${value.currency}`;
  }
  const parts = new Intl.NumberFormat(locale, {
    ...digits,
    style: 'currency',
    currency: fiat.code,
    currencyDisplay: 'narrowSymbol',
    numberingSystem: 'latn',
  }).formatToParts(text);
  const symbol = BRAND_SYMBOLS[fiat.code];
  const formatted = typeset(parts, symbol);
  // Only "$" is shared between currencies, so only "$" amounts get the code.
  if (codeDisplay !== 'whenAmbiguous' || symbol !== DOLLAR_SIGN) return formatted;
  // Left to right text is left exactly as it was; only right to left text
  // needs the isolate to lay positive and negative amounts out the same way.
  const code = isRightToLeft(locale) ? `${FSI}${fiat.code}${PDI}` : fiat.code;
  return `${formatted}${NBSP}${code}`;
}
