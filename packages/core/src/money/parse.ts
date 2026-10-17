// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { CurrencyCode } from './currencies.js';
import { InvalidAmountError, InvalidRoundingModeError } from './errors.js';
import { money, multiply } from './money.js';
import type { Money } from './money.js';
import { readOption } from './options.js';
import { divideRounded, parseRoundingMode } from './rescale.js';
import type { RoundingMode } from './rescale.js';

const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const NEGATIVE_ZERO = /^-0(\.0+)?$/;

// Far longer than any i128 at scale 18 (40 digits plus 18 and a sign), and
// short enough that the regex and BigInt never see a hostile megabyte.
const MAX_INPUT_LENGTH = 100;

function readRounding(options: unknown): RoundingMode | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== 'object' || options === null) {
    throw new InvalidRoundingModeError('options must be an object');
  }
  const rounding = readOption(options, 'rounding');
  return rounding === undefined ? undefined : parseRoundingMode(rounding);
}

/**
 * Parses a plain decimal such as "12.30" into minor units at `scale`.
 *
 * Only ASCII digits, an optional leading minus and one optional fraction are
 * accepted. A fraction shorter than `scale` is padded. A longer one throws
 * InvalidAmountError, even when the extra digits are zeros, unless
 * `options.rounding` is given, in which case the exact value is rounded.
 */
export function parseMoney(
  input: string,
  currency: CurrencyCode,
  scale: number,
  options?: { rounding?: RoundingMode },
): Money {
  const text: unknown = input;
  if (
    typeof text !== 'string' ||
    text.length > MAX_INPUT_LENGTH ||
    !DECIMAL.test(text) ||
    NEGATIVE_ZERO.test(text)
  ) {
    throw new InvalidAmountError('amount must be a plain decimal string');
  }
  // Validates the currency, then the scale, exactly as money() does.
  const unit = money(0n, currency, scale);
  const mode = readRounding(options);

  const negative = text.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const sign = negative ? -1n : 1n;

  if (fraction.length <= unit.scale) {
    const amount = sign * BigInt(whole + fraction.padEnd(unit.scale, '0'));
    return money(amount, unit.currency, unit.scale);
  }
  if (mode === undefined) {
    throw new InvalidAmountError('amount has more fraction digits than the scale allows');
  }
  const exact = sign * BigInt(whole + fraction);
  const dropped = BigInt(fraction.length) - BigInt(unit.scale);
  return money(divideRounded(exact, 10n ** dropped, mode), unit.currency, unit.scale);
}

/**
 * Canonical plain decimal with exactly `m.scale` fraction digits, for
 * example "12.30" for 1230 at scale 2. Never a negative zero.
 */
export function toDecimalString(m: Money): string {
  const value = multiply(m, 1n);
  const negative = value.amount < 0n;
  const magnitude = negative ? -value.amount : value.amount;
  const unit = 10n ** BigInt(value.scale);
  const whole = (magnitude / unit).toString();
  const sign = negative ? '-' : '';
  if (value.scale === 0) return sign + whole;
  const fraction = (magnitude % unit).toString().padStart(value.scale, '0');
  return `${sign}${whole}.${fraction}`;
}
