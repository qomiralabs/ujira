// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Personal data is encrypted with one data key per subject, and each data key
// is wrapped by a key encryption key that lives in a key manager. A leaked
// database therefore holds nothing that can be read. This package owns the
// port, so the production key manager changes by configuration and a test
// never needs a cloud account.

/**
 * What a wrapped key is bound to. A wrapped key copied to another tenant or
 * subject will not unwrap. A key manager may write these in an audit log in
 * clear, so they are identifiers and nothing else.
 */
export interface KeyWrapAad {
  readonly principalId: string;
  readonly projectId: string;
  readonly subjectId: string;
  readonly schemaVersion: number;
}

export interface WrappedKey {
  readonly wrapped: Uint8Array;
  /** The key that wrapped it, stored beside it and named again to unwrap. */
  readonly kekId: string;
}

export interface KeyManagerCallOptions {
  /** Aborts a call to a remote key manager at the caller's deadline. */
  readonly signal?: AbortSignal;
}

export interface KeyManager {
  /** The key new data keys are wrapped with. Older keys keep unwrapping. */
  readonly currentKekId: string;
  wrap(dek: Uint8Array, aad: KeyWrapAad, options?: KeyManagerCallOptions): Promise<WrappedKey>;
  unwrap(
    wrapped: Uint8Array,
    kekId: string,
    aad: KeyWrapAad,
    options?: KeyManagerCallOptions,
  ): Promise<Uint8Array>;
}

/**
 * The key manager refused: wrong associated data, an unknown or disabled key,
 * refused access. Retrying will not help, so it is never retried. It says
 * nothing about the value, the key or the tenant.
 */
export class KeyManagerRefusedError extends Error {
  override readonly name = 'KeyManagerRefusedError';
  constructor() {
    super('The key manager refused the request');
  }
}

/** The key manager could not answer: a throttle, a timeout or an outage. Worth retrying. */
export class KeyManagerUnavailableError extends Error {
  override readonly name = 'KeyManagerUnavailableError';
  constructor() {
    super('The key manager is unavailable');
  }
}

/** A key that is not 32 bytes, associated data that is not identifiers, a bad configuration. */
export class KeyManagerInputError extends Error {
  override readonly name = 'KeyManagerInputError';
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The associated data under the names both the audit log and the ciphertext
 * carry, every value checked and written as text. Each backend binds exactly
 * this, so one that could read another's output would agree on what it means.
 */
export function aadFields(aad: KeyWrapAad): Readonly<Record<string, string>> {
  const ids = {
    principal_id: aad.principalId,
    project_id: aad.projectId,
    subject_id: aad.subjectId,
  };
  for (const [name, value] of Object.entries(ids)) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
      throw new KeyManagerInputError(`aad.${name} is not an identifier`);
    }
  }
  if (!Number.isSafeInteger(aad.schemaVersion) || aad.schemaVersion < 1) {
    throw new KeyManagerInputError('aad.schema_version is not a positive integer');
  }
  return { ...ids, schema_version: String(aad.schemaVersion) };
}
