// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export type MoneyErrorCode =
  | 'MONEY_OVERFLOW'
  | 'CURRENCY_MISMATCH'
  | 'SCALE_MISMATCH'
  | 'UNKNOWN_CURRENCY'
  | 'INVALID_AMOUNT'
  | 'INVALID_SCALE'
  | 'INVALID_ALLOCATION';

/**
 * Base class for every money failure. Callers branch on `code`, which stays
 * stable across releases, rather than on message text.
 */
export abstract class MoneyError extends Error {
  abstract readonly code: MoneyErrorCode;
}

// Each subclass spells its own name out so minified builds keep readable names.

export class MoneyOverflowError extends MoneyError {
  override readonly name = 'MoneyOverflowError';
  readonly code = 'MONEY_OVERFLOW';
}

export class CurrencyMismatchError extends MoneyError {
  override readonly name = 'CurrencyMismatchError';
  readonly code = 'CURRENCY_MISMATCH';
}

export class ScaleMismatchError extends MoneyError {
  override readonly name = 'ScaleMismatchError';
  readonly code = 'SCALE_MISMATCH';
}

export class UnknownCurrencyError extends MoneyError {
  override readonly name = 'UnknownCurrencyError';
  readonly code = 'UNKNOWN_CURRENCY';
}

export class InvalidAmountError extends MoneyError {
  override readonly name = 'InvalidAmountError';
  readonly code = 'INVALID_AMOUNT';
}

export class InvalidScaleError extends MoneyError {
  override readonly name = 'InvalidScaleError';
  readonly code = 'INVALID_SCALE';
}

export class InvalidAllocationError extends MoneyError {
  override readonly name = 'InvalidAllocationError';
  readonly code = 'INVALID_ALLOCATION';
}
