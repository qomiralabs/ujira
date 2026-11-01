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
] as const);

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

// Messages are fixed per code. A message built from input could carry a
// recipient's details into a log or an error tracker.
const MESSAGES: Readonly<Record<IdentityErrorCode, string>> = {
  IDENTITY_INVALID_INPUT: 'Invalid identity request',
  IDENTITY_CONFIG_INVALID: 'Invalid identity configuration',
  IDENTITY_TENANT_MISMATCH: 'A store returned a row of another tenant',
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
