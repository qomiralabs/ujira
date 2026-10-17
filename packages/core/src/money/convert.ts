// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The only ways a value changes unit. Each one is named for the kind of rate
// it uses, so every unit change in the codebase can be found and reviewed.

import { settlementToken } from './currencies.js';
import type { Chain, FiatCurrencyCode, TokenAsset } from './currencies.js';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  InvalidScaleError,
  UnknownCurrencyError,
} from './errors.js';
import {
  I128_MAX,
  build,
  buildToken,
  checked,
  minorUnits,
  parseFiatCurrency,
  parseFiatScale,
  powerOfTen,
  snapshot,
  snapshotFiat,
  snapshotToken,
} from './money.js';
import type { Money, TokenAmount } from './money.js';
import { isPlainRecord, readOwnField } from './options.js';
import { divideRounded, parseRoundingMode } from './rescale.js';
import type { RoundingMode } from './rescale.js';

/**
 * An exact rate: numerator / denominator target units per source unit, each
 * at the scale its value is held at. Both parts are bigints above zero.
 */
export interface Rate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * Logical US dollars to a dollar token on a chain, at par. The result is at
 * the token's decimals: scaling up is exact, and scaling down is allowed only
 * when no non-zero digit is dropped. Limits and budgets must never round, so
 * there is deliberately no rounding mode here; a value that would lose
 * digits throws InvalidScaleError. Every settlement token is dollar pegged
 * today (see DOLLAR_PEGGED).
 */
export function usdToToken(usd: Money, asset: TokenAsset, chain: Chain): TokenAmount {
  const value = snapshotFiat(usd);
  if (value.currency !== 'USD') {
    throw new CurrencyMismatchError('only US dollars convert to a dollar token at par');
  }
  const token = settlementToken(asset, chain);
  if (token.tokenScale >= value.scale) {
    const factor = powerOfTen(token.tokenScale) / powerOfTen(value.scale);
    return buildToken(value.amount * factor, token.asset, token.chain);
  }
  const divisor = powerOfTen(value.scale) / powerOfTen(token.tokenScale);
  if (value.amount % divisor !== 0n) {
    throw new InvalidScaleError('the amount has more decimals than the token can hold');
  }
  return buildToken(value.amount / divisor, token.asset, token.chain);
}

/**
 * A dollar token back to US dollars at par, at the token's scale, for
 * display and for caps that combine chains. Exact: the scale is kept.
 */
export function tokenToUsd(t: TokenAmount): Money {
  const value = snapshotToken(t);
  return build(value.amount, 'USD', value.scale);
}

const RATE_TEXT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

// Enough for any quoted rate, and the parts stay below I128_MAX.
const MAX_RATE_DIGITS = 36;
// The digits plus one decimal point.
const MAX_RATE_TEXT_LENGTH = 37;

/**
 * Parses a quoted decimal rate such as "1600.25" into an exact Rate
 * (160025 / 100). Only plain positive decimals of at most 36 digits are
 * accepted: no sign, exponent, separator or whitespace, and never zero.
 * Anything else throws InvalidAmountError without echoing the text.
 */
export function parseRate(text: string): Rate {
  const input: unknown = text;
  // The length bound runs first, so the regex never sees a hostile megabyte.
  if (typeof input !== 'string' || input.length > MAX_RATE_TEXT_LENGTH || !RATE_TEXT.test(input)) {
    throw new InvalidAmountError('rate must be a plain positive decimal of at most 36 digits');
  }
  const [whole = '', fraction = ''] = input.split('.');
  const digits = whole + fraction;
  if (digits.length > MAX_RATE_DIGITS) {
    throw new InvalidAmountError('rate must be a plain positive decimal of at most 36 digits');
  }
  const numerator = BigInt(digits);
  if (numerator === 0n) {
    throw new InvalidAmountError('rate must be greater than zero');
  }
  // One zero per fraction digit gives the denominator as text.
  const denominator = BigInt(`1${fraction.replace(/[0-9]/g, '0')}`);
  return Object.freeze({ numerator, denominator });
}

function readRatePart(rate: object, key: 'numerator' | 'denominator'): bigint {
  const part = readOwnField(rate, key);
  if (typeof part !== 'bigint' || part <= 0n || part > I128_MAX) {
    throw new InvalidAmountError('rate parts must be bigints above zero within i128');
  }
  return part;
}

function readRate(rate: unknown): Rate {
  if (!isPlainRecord(rate)) {
    throw new InvalidAmountError('rate must be a plain object with a numerator and a denominator');
  }
  return {
    numerator: readRatePart(rate, 'numerator'),
    denominator: readRatePart(rate, 'denominator'),
  };
}

function readTarget(to: unknown): object {
  if (!isPlainRecord(to)) {
    throw new UnknownCurrencyError(
      'the target must be a plain object naming a currency or a token',
    );
  }
  return to;
}

/** source amount * rate, rounded once, with the product bounded to i128. */
function priced(amount: bigint, rate: Rate, mode: RoundingMode): bigint {
  return divideRounded(checked(amount * rate.numerator), rate.denominator, mode);
}

/**
 * Converts fiat money or a token amount to fiat with an exact rate, for
 * quotes and FX. The result is at `to.scale`, or the target currency's minor
 * unit, and is rounded once with the required `rounding`. Validation order:
 * source, rate, target currency and scale, rounding. The product and the
 * result are both bounded to i128.
 */
export function convertMoney(
  from: Money | TokenAmount,
  rate: Rate,
  to: { currency: FiatCurrencyCode; scale?: number },
  rounding: RoundingMode,
): Money {
  const value = snapshot(from);
  const r = readRate(rate);
  const target = readTarget(to);
  const currency = parseFiatCurrency(readOwnField(target, 'currency'));
  const scaleOption = readOwnField(target, 'scale');
  const scale =
    scaleOption === undefined ? minorUnits(currency) : parseFiatScale(scaleOption, currency);
  const mode = parseRoundingMode(rounding);
  return build(priced(value.amount, r, mode), currency, scale);
}

/**
 * Converts fiat money or a token amount to a token with an exact rate. The
 * result is at the token's decimals, rounded once with the required
 * `rounding`. Validation order: source, rate, target asset and chain,
 * rounding. The product and the result are both bounded to i128.
 */
export function convertToToken(
  from: Money | TokenAmount,
  rate: Rate,
  to: { asset: TokenAsset; chain: Chain },
  rounding: RoundingMode,
): TokenAmount {
  const value = snapshot(from);
  const r = readRate(rate);
  const target = readTarget(to);
  const token = settlementToken(
    readOwnField(target, 'asset') as string,
    readOwnField(target, 'chain') as string,
  );
  const mode = parseRoundingMode(rounding);
  return buildToken(priced(value.amount, r, mode), token.asset, token.chain);
}
