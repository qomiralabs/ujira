// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Wraps the per subject data keys that protect recipient personal data and
// webhook secrets. The key encryption key stays in KMS, so a database leak
// alone exposes nothing. The encryption context binds each wrapped key to
// its tenant and subject: a wrapped key copied to another row will not
// unwrap. The context appears in the audit log in clear, so it holds
// identifiers and nothing else, which the port's aadFields checks.

import {
  KeyManagerInputError,
  KeyManagerRefusedError,
  KeyManagerUnavailableError,
  aadFields,
} from '@ujira/db/key-manager';
import type {
  KeyManager,
  KeyManagerCallOptions,
  KeyWrapAad,
  WrappedKey,
} from '@ujira/db/key-manager';

import { KmsCallError } from './client.js';
import type { KmsClient } from './client.js';

/** The variable holding the ARN of the key encryption key. */
export const PII_KEK_VARIABLE = 'UJIRA_PII_KEK_ID';

/** All this role may do. It can never sign. */
export const KEY_MANAGER_IAM_ACTIONS: readonly string[] = Object.freeze([
  'kms:Encrypt',
  'kms:Decrypt',
]);

const DEK_BYTES = 32;

// What needs a person, or a different request. A wrong context is reported as
// InvalidCiphertextException, indistinguishable from a wrong key, as it should
// be. Anything not named is treated as an outage: a retry is bounded and ends
// where a person sees it.
const REFUSED: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'DisabledException',
  'IncorrectKeyException',
  'InvalidCiphertextException',
  'InvalidKeyUsageException',
  'KMSInvalidStateException',
  'NotFoundException',
]);

function portError(error: unknown): KeyManagerRefusedError | KeyManagerUnavailableError {
  return error instanceof KmsCallError && REFUSED.has(error.errorName)
    ? new KeyManagerRefusedError()
    : new KeyManagerUnavailableError();
}

export interface AwsKmsKeyManagerOptions {
  readonly client: KmsClient;
  /** The ARN from UJIRA_PII_KEK_ID. */
  readonly kekId: string;
  /** The deadline for one KMS call, on top of the caller's own signal. */
  readonly timeoutMs: number;
}

export class AwsKmsKeyManager implements KeyManager {
  readonly currentKekId: string;
  readonly #client: KmsClient;
  readonly #timeoutMs: number;

  constructor(options: AwsKmsKeyManagerOptions) {
    if (options.kekId === '') throw new KeyManagerInputError(`${PII_KEK_VARIABLE} is not set`);
    this.currentKekId = options.kekId;
    this.#client = options.client;
    this.#timeoutMs = options.timeoutMs;
  }

  #signal(options: KeyManagerCallOptions | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    return options?.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  }

  async wrap(
    dek: Uint8Array,
    aad: KeyWrapAad,
    options?: KeyManagerCallOptions,
  ): Promise<WrappedKey> {
    if (!(dek instanceof Uint8Array) || dek.length !== DEK_BYTES) {
      throw new KeyManagerInputError('A data key is 32 bytes');
    }
    const context = aadFields(aad);
    try {
      const { ciphertext } = await this.#client.encrypt(this.currentKekId, dek, context, {
        signal: this.#signal(options),
      });
      return { wrapped: ciphertext, kekId: this.currentKekId };
    } catch (error) {
      throw portError(error);
    }
  }

  async unwrap(
    wrapped: Uint8Array,
    kekId: string,
    aad: KeyWrapAad,
    options?: KeyManagerCallOptions,
  ): Promise<Uint8Array> {
    const context = aadFields(aad);
    try {
      return await this.#client.decrypt(kekId, wrapped, context, {
        signal: this.#signal(options),
      });
    } catch (error) {
      throw portError(error);
    }
  }
}
