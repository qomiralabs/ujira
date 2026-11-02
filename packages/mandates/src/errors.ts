// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Messages are fixed per class, so nothing from a request, an address or a
// store's own error text reaches a log through them.

export const MANDATE_POLICY_ERROR_CODES = Object.freeze([
  'CUSTODY_GUARD',
  'OPERATIONS_GUARDIAN_NOT_CONFIGURED',
  'PRINCIPAL_KEY_RISK',
  'POLICY_STORE_TIMEOUT',
  'POLICY_STORE_FAILED',
] as const);

export type MandatePolicyErrorCode = (typeof MANDATE_POLICY_ERROR_CODES)[number];

/** Base of every mandate policy failure. Branch on `code`. */
export abstract class MandatePolicyError extends Error {
  abstract readonly code: MandatePolicyErrorCode;
}

/**
 * A mandate in attested only mode would have an agent key UJIRA holds. UJIRA
 * also runs the attester, so one compromise of its signing path could then
 * send funds anywhere; the principal's allowlist must bind the destination.
 * The fix is a mandate in allowlist or both mode, or the principal's own
 * agent key.
 */
export class CustodyGuardError extends MandatePolicyError {
  override readonly name = 'CustodyGuardError';
  readonly code = 'CUSTODY_GUARD';

  constructor() {
    super('A mandate with a UJIRA held agent key must use allowlist or both mode');
  }
}

/** The ways a principal can come back under the principal key rule. */
export const PRINCIPAL_KEY_FIXES = Object.freeze([
  'add_recovery_set',
  'use_multisig_principal',
  'lower_budget',
] as const);

export type PrincipalKeyFix = (typeof PRINCIPAL_KEY_FIXES)[number];

/**
 * The principal's mandates total more than 50,000 USD and at least one
 * instance has no multisig principal and no recovery set with a threshold of
 * two, so a single lost key could strand the funds.
 */
export class PrincipalKeyRiskError extends MandatePolicyError {
  override readonly name = 'PrincipalKeyRiskError';
  readonly code = 'PRINCIPAL_KEY_RISK';
  /** The opaque IDs of the instances that do not qualify. */
  readonly unqualified: readonly string[];
  readonly fixes: readonly PrincipalKeyFix[] = PRINCIPAL_KEY_FIXES;

  constructor(unqualified: readonly string[]) {
    super('Above 50,000 USD a mandate needs a multisig principal or a recovery set');
    this.unqualified = Object.freeze([...unqualified]);
  }
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
