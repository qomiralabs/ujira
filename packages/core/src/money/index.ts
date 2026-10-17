// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export { MAX_ALLOCATION_LEGS, allocate } from './allocate.js';
export {
  CurrencyMismatchError,
  InvalidAllocationError,
  InvalidAmountError,
  InvalidLocaleError,
  InvalidRoundingModeError,
  InvalidScaleError,
  MoneyError,
  MoneyOverflowError,
  ScaleMismatchError,
  UnknownCurrencyError,
} from './errors.js';
export type { MoneyErrorCode } from './errors.js';
export {
  FIAT_CURRENCIES,
  SETTLEMENT_TOKENS,
  fiatCurrency,
  isCurrencyCode,
  settlementToken,
} from './currencies.js';
export type {
  Chain,
  CurrencyCode,
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
  multiply,
  negate,
  subtract,
  sum,
} from './money.js';
export type { Money } from './money.js';
export { formatMoney } from './format.js';
export { parseMoney, toDecimalString } from './parse.js';
export { ROUNDING_MODES, rescale } from './rescale.js';
export type { RoundingMode } from './rescale.js';
