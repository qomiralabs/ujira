// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Thrown errors are for faults: a malformed call or a broken configuration.
// A recipient who may not be paid is an answer, returned as a refusal
// reason, never thrown.

import type { z } from 'zod';

export const IDENTITY_ERROR_CODES = Object.freeze([
  'IDENTITY_INVALID_INPUT',
  'IDENTITY_CONFIG_INVALID',
  'IDENTITY_TENANT_MISMATCH',
  'IDENTITY_CALL_TIMEOUT',
  'IDENTITY_CALL_ABORTED',
  'IDENTITY_ATTESTATION_CONFLICT',
  'IDENTITY_ATTESTATION_STATE',
  'IDENTITY_ATTESTATION_MESSAGE_INVALID',
  'IDENTITY_SIGNING_FAILED',
] as const);

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

// Messages are fixed per code. A message built from input could carry a
// recipient's details into a log or an error tracker.
const MESSAGES: Readonly<Record<IdentityErrorCode, string>> = {
  IDENTITY_INVALID_INPUT: 'Invalid identity request',
  IDENTITY_CONFIG_INVALID: 'Invalid identity configuration',
  IDENTITY_TENANT_MISMATCH: 'A store returned a row of another tenant',
  IDENTITY_CALL_TIMEOUT: 'An external call timed out',
  IDENTITY_CALL_ABORTED: 'The caller abandoned the call',
  IDENTITY_ATTESTATION_CONFLICT: 'An attestation with the same digest and key already exists',
  IDENTITY_ATTESTATION_STATE: 'An attestation can only leave the pending state once',
  IDENTITY_ATTESTATION_MESSAGE_INVALID: 'The attestation message is not 47 bytes',
  IDENTITY_SIGNING_FAILED: 'The attester did not produce a valid signature',
};

/** Every subclass sets its own `name`, so a caught error says what it is. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  protected constructor(code: IdentityErrorCode, options?: { readonly cause?: unknown }) {
    super(MESSAGES[code], options);
    this.code = code;
  }
}

/** A request whose ids or tenant are malformed. `issues` name fields, never values. */
export class IdentityInputError extends IdentityError {
  override readonly name = 'IdentityInputError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('IDENTITY_INVALID_INPUT');
    this.issues = Object.freeze([...issues]);
  }
}

/** Configuration that fails its schema. `issues` name fields, never values. */
export class IdentityConfigError extends IdentityError {
  override readonly name = 'IdentityConfigError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('IDENTITY_CONFIG_INVALID');
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * A store handed back a row whose tenant is not the caller's. That is a
 * repository bug, and acting on the row would cross tenants, so the call
 * fails instead of reading it as absent.
 */
export class IdentityTenantMismatchError extends IdentityError {
  override readonly name = 'IdentityTenantMismatchError';

  constructor() {
    super('IDENTITY_TENANT_MISMATCH');
  }
}

/** An external call outlived its timeout. Worth another try later. */
export class CallTimeoutError extends IdentityError {
  override readonly name = 'CallTimeoutError';

  constructor() {
    super('IDENTITY_CALL_TIMEOUT');
  }
}

/** The caller's own signal fired. The caller gave up, so nothing answers. */
export class CallAbortedError extends IdentityError {
  override readonly name = 'CallAbortedError';

  constructor(options?: { readonly cause?: unknown }) {
    super('IDENTITY_CALL_ABORTED', options);
  }
}

/**
 * The digest and key are unique, so the same message cannot be logged twice.
 * Another attempt is attesting the same leg in the same second.
 */
export class AttestationConflictError extends IdentityError {
  override readonly name = 'AttestationConflictError';

  constructor() {
    super('IDENTITY_ATTESTATION_CONFLICT');
  }
}

/** A signed or failed attestation was asked to change again. */
export class AttestationStateError extends IdentityError {
  override readonly name = 'AttestationStateError';

  constructor() {
    super('IDENTITY_ATTESTATION_STATE');
  }
}

/** The adapter built something that is not the 47 byte message. Nothing is logged or signed. */
export class AttestationMessageError extends IdentityError {
  override readonly name = 'AttestationMessageError';

  constructor() {
    super('IDENTITY_ATTESTATION_MESSAGE_INVALID');
  }
}

/**
 * The attester failed or returned a signature that does not verify. The
 * pending row is marked failed before this is thrown; `failureCode` is what
 * the row records.
 */
export class AttestationSigningError extends IdentityError {
  override readonly name = 'AttestationSigningError';
  readonly failureCode: string;

  constructor(failureCode: string, options?: { readonly cause?: unknown }) {
    super('IDENTITY_SIGNING_FAILED', options);
    this.failureCode = failureCode;
  }
}

export function isIdentityError(value: unknown): value is IdentityError {
  return value instanceof IdentityError;
}

/**
 * "path (code)" for each zod issue. zod's own messages can quote the
 * rejected value, which may be personal data, so only the path and the
 * issue code are kept.
 */
export function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
    return `${path} (${issue.code})`;
  });
}
