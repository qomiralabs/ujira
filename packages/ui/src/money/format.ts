// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { formatMoney as formatCoreMoney, money } from '@ujira/core';
import type { CurrencyCodeDisplay, FiatCurrencyCode } from '@ujira/core';

/**
 * Integer minor units: a bigint, or the decimal string of one as the API
 * sends it ("9600" is 96.00 dollars). Never a number.
 */
export type MinorUnits = bigint | string;

export interface FormatMoneyOptions {
  /**
   * 'whenAmbiguous' follows every dollar amount with its ISO code. Principal
   * views get it from AmountProvider; recipient surfaces never set it.
   */
  currencyCode?: CurrencyCodeDisplay;
}

/**
 * Formats integer minor units for people, through the core money model:
 * `formatMoney(2_000_000n, 'NGN', 'en')` is "₦20,000.00". The value is built
 * with the core `money` constructor, so a decimal such as "96.00", a number or
 * an amount outside the signed 128 bit range throws instead of printing
 * something wrong. The result is for display only; never parse it back.
 */
export function formatMoney(
  minor: MinorUnits,
  currency: FiatCurrencyCode,
  locale: string,
  options: FormatMoneyOptions = {},
): string {
  return formatCoreMoney(money(minor, currency), { locale, ...options });
}

// For engines that cannot report a locale's direction themselves.
const RTL_SCRIPTS: ReadonlySet<string> = new Set([
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

interface LocaleTextInfo {
  getTextInfo?: () => { direction?: string };
  readonly textInfo?: { direction?: string };
}

function readDirection(source: () => { direction?: string } | undefined): string | undefined {
  try {
    return source()?.direction;
  } catch {
    return undefined;
  }
}

/**
 * Whether a locale the core formatter has already accepted writes right to
 * left, asked the same way the formatter asks: the engine's text info first,
 * then the locale's likely script.
 */
export function localeDirection(locale: string): 'ltr' | 'rtl' {
  const parsed = new Intl.Locale(locale);
  const info = parsed as unknown as LocaleTextInfo;
  const direction =
    readDirection(() =>
      typeof info.getTextInfo === 'function' ? info.getTextInfo() : undefined,
    ) ?? readDirection(() => info.textInfo);
  if (direction !== undefined) return direction === 'rtl' ? 'rtl' : 'ltr';
  return RTL_SCRIPTS.has(parsed.maximize().script ?? '') ? 'rtl' : 'ltr';
}
