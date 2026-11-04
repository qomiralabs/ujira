// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Messages are fixed per class. A message built from input could carry a
// principal's details or an address into a log or an error tracker.

export const FUNDING_ERROR_CODES = Object.freeze([
  'FUNDING_ACCOUNT_CONFLICT',
  'FUNDING_ACCOUNT_STATE',
  'FUNDING_INVALID_INPUT',
  'SWEEP_STATE',
  'SWEEP_TENANT_MISMATCH',
  'SWEEP_TIMEOUT',
] as const);

export type FundingErrorCode = (typeof FUNDING_ERROR_CODES)[number];

/** Every subclass sets its own `name`, so a caught error says what it is. */
export abstract class FundingError extends Error {
  readonly code: FundingErrorCode;

  protected constructor(code: FundingErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A request that fails its schema. `issues` name fields, never values. */
export class FundingInputError extends FundingError {
  override readonly name = 'FundingInputError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('FUNDING_INVALID_INPUT', 'Invalid funding request');
    this.issues = Object.freeze([...issues]);
  }
}

/** There is no active funding account for this step, or the mandate instance cannot use it. */
export class FundingAccountStateError extends FundingError {
  override readonly name = 'FundingAccountStateError';

  constructor() {
    super('FUNDING_ACCOUNT_STATE', 'No usable funding account for this step');
  }
}

/**
 * The principal already holds a different account on this network, or another
 * row holds this address. What landed on chain is real and the row is not, so
 * this needs a person, and is surfaced rather than quietly dropped.
 */
export class FundingAccountConflictError extends FundingError {
  override readonly name = 'FundingAccountConflictError';

  constructor() {
    super('FUNDING_ACCOUNT_CONFLICT', 'The funding account conflicts with one already recorded');
  }
}

/** The sweep does not exist for this tenant, or is not in a state that allows the step. */
export class SweepStateError extends FundingError {
  override readonly name = 'SweepStateError';

  constructor() {
    super('SWEEP_STATE', 'The sweep does not allow this step');
  }
}

/**
 * The deposit is already recorded under another tenant. Deposit ids are unique
 * per chain, so this is a mistake in how a deposit was attributed. Surfaced
 * rather than resolved, so a sweep never reaches the wrong tenant.
 */
export class SweepTenantError extends FundingError {
  override readonly name = 'SweepTenantError';

  constructor() {
    super('SWEEP_TENANT_MISMATCH', 'The deposit belongs to another tenant');
  }
}

/** The chain did not answer in time. A send may still have gone through. */
export class SweepTimeoutError extends FundingError {
  override readonly name = 'SweepTimeoutError';

  constructor() {
    super('SWEEP_TIMEOUT', 'The chain did not answer in time');
  }
}
