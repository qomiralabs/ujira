// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// AWS KMS as far as the backends can tell, in memory: keys appear on first
// use, ciphertext is bound to its encryption context, and any call can be
// made to fail by the service's own error names. No account, no credentials
// and no network.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';

import { KmsCallError } from '../aws-kms/client.js';
import { ED25519_SPEC } from '../aws-kms/signer.js';
import type {
  KmsCallOptions,
  KmsCiphertext,
  KmsClient,
  KmsEncryptionContext,
  KmsPublicKey,
  KmsSignature,
} from '../aws-kms/client.js';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type KmsOperation = 'getPublicKey' | 'sign' | 'encrypt' | 'decrypt';

export class FakeKmsClient implements KmsClient {
  /** Every call made, for tests that check a call was or was not made. */
  readonly calls: { readonly operation: KmsOperation; readonly keyId: string }[] = [];
  /** Overrides what getPublicKey reports, for keys of the wrong kind. */
  keySpec: string = ED25519_SPEC;
  #failures: { readonly operation: KmsOperation | null; readonly errorName: string }[] = [];
  #badSignature = false;

  /** Makes the next matching call fail with this service error. */
  failNext(errorName: string, operation: KmsOperation | null = null): void {
    this.#failures.push({ operation, errorName });
  }

  /** Makes the next signature come back wrong. */
  corruptNextSignature(): void {
    this.#badSignature = true;
  }

  #enter(operation: KmsOperation, keyId: string, options: KmsCallOptions): void {
    this.calls.push({ operation, keyId });
    if (options.signal.aborted) throw new KmsCallError('AbortError');
    const at = this.#failures.findIndex((f) => f.operation === null || f.operation === operation);
    const failure = this.#failures[at];
    if (failure !== undefined) {
      this.#failures.splice(at, 1);
      throw new KmsCallError(failure.errorName, 'fake-request-id');
    }
  }

  #secret(keyId: string): Uint8Array {
    return Uint8Array.from(createHash('sha256').update(`fake-kms/${keyId}`).digest());
  }

  getPublicKey(keyId: string, options: KmsCallOptions): Promise<KmsPublicKey> {
    return Promise.resolve().then(() => {
      this.#enter('getPublicKey', keyId, options);
      const key = ed25519.getPublicKey(this.#secret(keyId));
      return {
        keySpec: this.keySpec,
        spki: Uint8Array.from(Buffer.concat([SPKI_PREFIX, key])),
      };
    });
  }

  sign(keyId: string, message: Uint8Array, options: KmsCallOptions): Promise<KmsSignature> {
    return Promise.resolve().then(() => {
      this.#enter('sign', keyId, options);
      const signature = ed25519.sign(message, this.#secret(keyId));
      if (this.#badSignature) {
        this.#badSignature = false;
        return { signature: new Uint8Array(64), requestId: 'fake-request-id' };
      }
      return { signature, requestId: 'fake-request-id' };
    });
  }

  #aad(context: KmsEncryptionContext): Buffer {
    return Buffer.from(JSON.stringify(Object.entries(context).sort()), 'utf8');
  }

  encrypt(
    keyId: string,
    plaintext: Uint8Array,
    context: KmsEncryptionContext,
    options: KmsCallOptions,
  ): Promise<KmsCiphertext> {
    return Promise.resolve().then(() => {
      this.#enter('encrypt', keyId, options);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#secret(keyId), iv);
      cipher.setAAD(this.#aad(context));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        ciphertext: Uint8Array.from(Buffer.concat([iv, cipher.getAuthTag(), body])),
        keyId,
      };
    });
  }

  decrypt(
    keyId: string,
    ciphertext: Uint8Array,
    context: KmsEncryptionContext,
    options: KmsCallOptions,
  ): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      this.#enter('decrypt', keyId, options);
      const bytes = Buffer.from(ciphertext);
      const decipher = createDecipheriv('aes-256-gcm', this.#secret(keyId), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(this.#aad(context));
      try {
        return Uint8Array.from(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]),
        );
      } catch {
        // What the service answers for a wrong context or a wrong key.
        throw new KmsCallError('InvalidCiphertextException', 'fake-request-id');
      }
    });
  }
}
