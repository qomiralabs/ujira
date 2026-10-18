// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The only ways a value changes unit. Each one is named for the kind of rate
// it uses, so every unit change in the codebase can be found and reviewed.

import { isFiatCurrencyCode, isTokenAsset, settlementToken } from './currencies.js';
import type { Chain, FiatCurrencyCode, TokenAsset } from './currencies.js';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  InvalidScaleError,
  RateMismatchError,
  UnknownCurrencyError,
} from './errors.js';
import {
  build,
  buildToken,
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
 * What a rate converts from or to: a fiat currency, or a token asset on any
 * chain. A token is priced as its own asset, never as the dollar it tracks.
 */
export type RateUnit = FiatCurrencyCode | TokenAsset;

/**
 * An exact rate in major units, exactly as quoted: numerator / denominator
 * major units of `quote` per major unit of `base`, so "1600.25" NGN per USD
 * is base USD, quote NGN, 160025 / 100, whatever the token's decimals or the
 * target's scale. A rate is never pre-scaled by a power of ten; the
 * conversions apply both scales themselves. Both parts are bigints above
 * zero of at most 36 digits.
 *
 * The pair travels with the numbers so a rate quoted for one corridor can
 * never price another, and so reading it upside down takes invertRate.
 *
 * Build one with parseRate or invertRate; conversions refuse any other
 * object, a spread or copy of a real rate included. A rate from a unit to
 * itself must be exactly 1.
 */
export interface Rate {
  readonly base: RateUnit;
  readonly quote: RateUnit;
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * Logical US dollars to a dollar token on a chain, at par. The result is at
 * the token's decimals: scaling up is exact, and scaling down is allowed only
 * when no non-zero digit is dropped. Limits and budgets must never round, so
 * there is deliberately no rounding mode here; a value that would lose
 * digits throws InvalidScaleError. The only settlement token, USDC, is
 * pegged to the dollar; a token that is not would need a priced conversion
 * instead.
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

// Enough for any quoted rate. Each part of a Rate is held to the same bound,
// so a product in a conversion stays well under 10^100.
const MAX_RATE_DIGITS = 36;
// The digits plus one decimal point.
const MAX_RATE_TEXT_LENGTH = 37;
const MAX_RATE_PART = 10n ** 36n - 1n;

function parseRateUnit(value: unknown): RateUnit {
  if (isFiatCurrencyCode(value) || isTokenAsset(value)) return value;
  throw new UnknownCurrencyError('rate base and quote must be fiat currency codes or token assets');
}

function readPair(pair: unknown): { base: RateUnit; quote: RateUnit } {
  if (!isPlainRecord(pair)) {
    throw new UnknownCurrencyError('the rate pair must be a plain object with a base and a quote');
  }
  return {
    base: parseRateUnit(readOwnField(pair, 'base')),
    quote: parseRateUnit(readOwnField(pair, 'quote')),
  };
}

/**
 * Parses a quoted decimal rate such as "1600.25" NGN per USD into an exact
 * Rate (base USD, quote NGN, 160025 / 100). Only plain positive decimals of
 * at most 36 digits are accepted: no sign, exponent, separator or
 * whitespace, and never zero; anything else throws InvalidAmountError
 * without echoing the text. The text is checked before the pair, whose
 * base and quote must be known fiat codes or token assets, else
 * UnknownCurrencyError.
 */
export function parseRate(text: string, pair: { base: RateUnit; quote: RateUnit }): Rate {
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
  const { base, quote } = readPair(pair);
  checkSameUnit(base, quote, numerator, denominator);
  return issue({ base, quote, numerator, denominator });
}

// Rates handed out by parseRate and invertRate. A Rate is plain data, so
// without this a spread such as { ...rate, quote: 'KES' } or a hand-built
// object would price a corridor nobody quoted. Frozen rates in a WeakSet
// cannot be edited after the fact, and the set never keeps one alive.
const ISSUED = new WeakSet<object>();

function issue(rate: Rate): Rate {
  const frozen = Object.freeze(rate);
  ISSUED.add(frozen);
  return frozen;
}

// A unit priced in itself has one honest value. Anything else would move
// money between the same unit at a ratio, a token across chains included.
function checkSameUnit(base: RateUnit, quote: RateUnit, numerator: bigint, denominator: bigint) {
  if (base === quote && numerator !== denominator) {
    throw new RateMismatchError('a rate from a unit to itself must be exactly 1');
  }
}

function readRatePart(rate: object, key: 'numerator' | 'denominator'): bigint {
  const part = readOwnField(rate, key);
  if (typeof part !== 'bigint' || part <= 0n || part > MAX_RATE_PART) {
    throw new InvalidAmountError('rate parts must be bigints above zero of at most 36 digits');
  }
  return part;
}

function readRate(rate: unknown): Rate {
  if (!isPlainRecord(rate)) {
    throw new InvalidAmountError('rate must be a plain object with a numerator and a denominator');
  }
  const numerator = readRatePart(rate, 'numerator');
  const denominator = readRatePart(rate, 'denominator');
  const { base, quote } = readPair(rate);
  // Issued rates passed the same unit check when they were made, and are
  // frozen, so the brand covers it here.
  if (!ISSUED.has(rate)) {
    throw new RateMismatchError('only rates from parseRate or invertRate convert');
  }
  return { base, quote, numerator, denominator };
}

/**
 * The same rate read the other way: USD per NGN from NGN per USD. Base and
 * quote swap and so do the parts, exactly. Conversions never do this on
 * their own, so a rate applied the wrong way round throws instead.
 */
export function invertRate(rate: Rate): Rate {
  const r = readRate(rate);
  return issue({
    base: r.quote,
    quote: r.base,
    numerator: r.denominator,
    denominator: r.numerator,
  });
}

// Fiat is priced by its currency and a token by its asset, on any chain.
function checkPair(r: Rate, source: RateUnit, target: RateUnit): void {
  if (source !== r.base || target !== r.quote) {
    throw new RateMismatchError(
      'the rate base must be the source unit and its quote the target unit',
    );
  }
}

function readTarget(to: unknown): object {
  if (!isPlainRecord(to)) {
    throw new UnknownCurrencyError(
      'the target must be a plain object naming a currency or a token',
    );
  }
  return to;
}

/**
 * A rate is major units of target per major unit of source, so the amount
 * moves from its own scale to the target's inside one division and is
 * rounded once. Bigint products cannot overflow on the way; the caller's
 * build bounds the result to i128.
 */
function priced(
  amount: bigint,
  sourceScale: number,
  targetScale: number,
  rate: Rate,
  mode: RoundingMode,
): bigint {
  return divideRounded(
    amount * rate.numerator * powerOfTen(targetScale),
    rate.denominator * powerOfTen(sourceScale),
    mode,
  );
}

/**
 * Converts fiat money or a token amount to fiat with an exact rate, for
 * quotes and FX. The result is at `to.scale`, or the target currency's minor
 * unit, and is rounded once with the required `rounding`. The source unit
 * must be the rate's base and the target currency its quote, else
 * RateMismatchError. Validation order: source, rate, target currency and
 * scale, the pair, rounding. Only the result is bounded to i128: the
 * product on the way is a bigint, which cannot overflow, and the rate parts
 * are capped at 36 digits so it stays small.
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
  checkPair(r, value.kind === 'fiat' ? value.currency : value.asset, currency);
  const mode = parseRoundingMode(rounding);
  return build(priced(value.amount, value.scale, scale, r, mode), currency, scale);
}

/**
 * Converts fiat money or a token amount to a token with an exact rate. The
 * result is at the token's decimals, rounded once with the required
 * `rounding`. The source unit must be the rate's base and the target asset
 * its quote, else RateMismatchError. Validation order: source, rate, target
 * asset and chain, the pair, rounding. Only the result is bounded to i128:
 * the product on the way is a bigint, which cannot overflow, and the rate
 * parts are capped at 36 digits so it stays small.
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
  checkPair(r, value.kind === 'fiat' ? value.currency : value.asset, token.asset);
  const mode = parseRoundingMode(rounding);
  return buildToken(
    priced(value.amount, value.scale, token.tokenScale, r, mode),
    token.asset,
    token.chain,
  );
}
