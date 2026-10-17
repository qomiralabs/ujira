// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export { MAX_ALLOCATION_LEGS, allocate } from './allocate.js';
export { convertMoney, convertToToken, parseRate, tokenToUsd, usdToToken } from './convert.js';
export type { Rate } from './convert.js';
export {
  CurrencyMismatchError,
  InvalidAllocationError,
  InvalidAmountError,
  InvalidLocaleError,
  InvalidRoundingModeError,
  InvalidScaleError,
  KindMismatchError,
  MoneyError,
  MoneyOverflowError,
  ScaleMismatchError,
  TokenMismatchError,
  UnknownCurrencyError,
} from './errors.js';
export type { MoneyErrorCode } from './errors.js';
export {
  DOLLAR_PEGGED,
  FIAT_CURRENCIES,
  SETTLEMENT_TOKENS,
  TOKEN_DISPLAY_SCALE,
  fiatCurrency,
  isFiatCurrencyCode,
  isTokenAsset,
  settlementToken,
} from './currencies.js';
export type {
  Chain,
  FiatCurrency,
  FiatCurrencyCode,
  SettlementToken,
  TokenAsset,
} from './currencies.js';
export {
  I128_MAX,
  I128_MIN,
  MAX_SCALE,
  add,
  compare,
  equals,
  isNegative,
  isZero,
  money,
  moneyAt,
  multiply,
  negate,
  subtract,
  sum,
  tokenAmount,
} from './money.js';
export type { Money, TokenAmount } from './money.js';
export { formatMoney, formatTokenAmount } from './format.js';
export { parseMoney, parseTokenAmount, toDecimalString } from './parse.js';
export { ROUNDING_MODES, rescale, toMinor } from './rescale.js';
export type { RoundingMode } from './rescale.js';
