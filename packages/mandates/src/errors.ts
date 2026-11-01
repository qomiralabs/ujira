// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Messages are fixed per class, so nothing from a request, an address or a
// store's own error text reaches a log through them.

export const MANDATE_POLICY_ERROR_CODES = Object.freeze([
  'OPERATIONS_GUARDIAN_NOT_CONFIGURED',
  'POLICY_STORE_TIMEOUT',
  'POLICY_STORE_FAILED',
] as const);

export type MandatePolicyErrorCode = (typeof MANDATE_POLICY_ERROR_CODES)[number];

/** Base of every mandate policy failure. Branch on `code`. */
export abstract class MandatePolicyError extends Error {
  abstract readonly code: MandatePolicyErrorCode;
}

/**
 * A mandate would include the operations guardian, but none is configured
 * for its network. Creation stops rather than quietly leaving it out.
 */
export class OperationsGuardianNotConfiguredError extends MandatePolicyError {
  override readonly name = 'OperationsGuardianNotConfiguredError';
  readonly code = 'OPERATIONS_GUARDIAN_NOT_CONFIGURED';

  constructor() {
    super('No operations guardian is configured for this network');
  }
}

export class PolicyStoreTimeoutError extends MandatePolicyError {
  override readonly name = 'PolicyStoreTimeoutError';
  readonly code = 'POLICY_STORE_TIMEOUT';

  constructor() {
    super('Mandate policy store timed out');
  }
}

/** A policy store failed. The original error is kept as the cause. */
export class PolicyStoreError extends MandatePolicyError {
  override readonly name = 'PolicyStoreError';
  readonly code = 'POLICY_STORE_FAILED';

  constructor(cause: unknown) {
    super('Mandate policy store failed', { cause });
  }
}

export function isMandatePolicyError(value: unknown): value is MandatePolicyError {
  return value instanceof MandatePolicyError;
}
