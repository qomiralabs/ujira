// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Wraps the per subject data keys that protect recipient personal data and
// webhook secrets. The key encryption key stays in KMS, so a database leak
// alone exposes nothing. The encryption context binds each wrapped key to
// its tenant and subject: a wrapped key copied to another row will not
// unwrap. The context appears in the audit log in clear, so it holds
// identifiers and nothing else.

import { InvalidInputError, SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';

import { KmsCallError } from './client.js';
import type { KmsClient, KmsEncryptionContext } from './client.js';

/** The variable holding the ARN of the key encryption key. */
export const PII_KEK_VARIABLE = 'UJIRA_PII_KEK_ID';

/** All this role may do. It can never sign. */
export const KEY_MANAGER_IAM_ACTIONS: readonly string[] = Object.freeze([
  'kms:Encrypt',
  'kms:Decrypt',
]);

/** What a wrapped key is bound to; identifiers only. */
export interface WrapContext {
  readonly principalId: string;
  readonly projectId: string;
  readonly subjectId: string;
  readonly schemaVersion: number;
}

export interface WrappedKey {
  readonly ciphertext: Uint8Array;
  /** The key that wrapped it, stored beside it and named again to unwrap. */
  readonly kekId: string;
}

/**
 * The key wrapping port. It belongs to packages/db (#164); it is written out
 * here until that port lands, in the shape that issue describes.
 */
export interface KeyManager {
  readonly currentKekId: string;
  wrap(dataKey: Uint8Array, context: WrapContext, signal: AbortSignal): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, context: WrapContext, signal: AbortSignal): Promise<Uint8Array>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

// The names the audit log shows. Each value is checked, so nothing that is
// not an identifier can reach the log through a caller's mistake.
function encryptionContext(context: WrapContext): KmsEncryptionContext {
  const ids = {
    principal_id: context.principalId,
    project_id: context.projectId,
    subject_id: context.subjectId,
  };
  for (const [name, value] of Object.entries(ids)) {
    if (!ID.test(value)) throw new InvalidInputError({ issues: [`context.${name} (invalid)`] });
  }
  if (!Number.isSafeInteger(context.schemaVersion) || context.schemaVersion < 1) {
    throw new InvalidInputError({ issues: ['context.schema_version (invalid)'] });
  }
  return { ...ids, schema_version: String(context.schemaVersion) };
}

const DENIED: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'DisabledException',
  'IncorrectKeyException',
  'InvalidCiphertextException',
  'InvalidKeyUsageException',
  'KMSInvalidStateException',
  'NotFoundException',
]);

function portError(error: unknown): SignerDeniedError | SignerUnavailableError {
  const refused = error instanceof KmsCallError && DENIED.has(error.errorName);
  return refused ? new SignerDeniedError() : new SignerUnavailableError();
}

export interface AwsKmsKeyManagerOptions {
  readonly client: KmsClient;
  /** The ARN from UJIRA_PII_KEK_ID. */
  readonly kekId: string;
}

export class AwsKmsKeyManager implements KeyManager {
  readonly currentKekId: string;
  readonly #client: KmsClient;

  constructor(options: AwsKmsKeyManagerOptions) {
    if (options.kekId === '')
      throw new InvalidInputError({ issues: [`${PII_KEK_VARIABLE} (missing)`] });
    this.currentKekId = options.kekId;
    this.#client = options.client;
  }

  async wrap(dataKey: Uint8Array, context: WrapContext, signal: AbortSignal): Promise<WrappedKey> {
    const bound = encryptionContext(context);
    try {
      const { ciphertext } = await this.#client.encrypt(this.currentKekId, dataKey, bound, {
        signal,
      });
      return { ciphertext, kekId: this.currentKekId };
    } catch (error) {
      throw portError(error);
    }
  }

  async unwrap(
    wrapped: WrappedKey,
    context: WrapContext,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const bound = encryptionContext(context);
    try {
      return await this.#client.decrypt(wrapped.kekId, wrapped.ciphertext, bound, { signal });
    } catch (error) {
      throw portError(error);
    }
  }
}
