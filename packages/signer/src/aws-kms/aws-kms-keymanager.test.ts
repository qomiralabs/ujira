// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the KMS key manager (aws-kms/key-manager.ts), against a fake
 * client. No account, credentials or network are involved.
 *
 * It passes the suite every key manager must. wrap encrypts with the current
 * key under the encryption context { principal_id, project_id, subject_id,
 * schema_version }; unwrap decrypts with the stored key id under the same
 * context. Refusals are KeyManagerRefusedError and anything else is
 * KeyManagerUnavailableError, with nothing of the vendor's in either. A
 * context value that is not an identifier never reaches KMS.
 */

import {
  KeyManagerInputError,
  KeyManagerRefusedError,
  KeyManagerUnavailableError,
} from '@ujira/db/key-manager';
import type { KeyWrapAad } from '@ujira/db/key-manager';
import { describeKeyManager } from '@ujira/db/key-manager/contract';
import { describe, expect, it } from 'vitest';

import { FakeKmsClient } from '../testing/fake-kms.js';
import type { KmsClient, KmsEncryptionContext } from './client.js';
import { AwsKmsKeyManager } from './key-manager.js';

const KEK = 'arn:aws:kms:eu-central-1:000000000000:key/test';
const AAD: KeyWrapAad = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41',
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f',
  subjectId: 'subject-1',
  schemaVersion: 1,
};
const DEK = new Uint8Array(32).fill(5);

function setup() {
  const client = new FakeKmsClient();
  return { client, manager: new AwsKmsKeyManager({ client, kekId: KEK, timeoutMs: 5_000 }) };
}

describeKeyManager('AwsKmsKeyManager against a fake client', () => {
  const client = new FakeKmsClient();
  return {
    keyManager: new AwsKmsKeyManager({ client, kekId: 'old-key', timeoutMs: 5_000 }),
    rotated: new AwsKmsKeyManager({ client, kekId: 'new-key', timeoutMs: 5_000 }),
  };
});

describe('AwsKmsKeyManager', () => {
  it('sends KMS the context under the names the audit log shows', async () => {
    const contexts: KmsEncryptionContext[] = [];
    const fake = new FakeKmsClient();
    const client: KmsClient = {
      getPublicKey: (keyId, options) => fake.getPublicKey(keyId, options),
      sign: (keyId, message, options) => fake.sign(keyId, message, options),
      encrypt: (keyId, plaintext, context, options) => {
        contexts.push(context);
        return fake.encrypt(keyId, plaintext, context, options);
      },
      decrypt: (keyId, ciphertext, context, options) => {
        contexts.push(context);
        return fake.decrypt(keyId, ciphertext, context, options);
      },
    };
    const manager = new AwsKmsKeyManager({ client, kekId: KEK, timeoutMs: 5_000 });
    const { wrapped, kekId } = await manager.wrap(DEK, AAD);
    await manager.unwrap(wrapped, kekId, AAD);
    const expected = {
      principal_id: AAD.principalId,
      project_id: AAD.projectId,
      subject_id: AAD.subjectId,
      schema_version: '1',
    };
    expect(contexts).toEqual([expected, expected]);
  });

  it.each<[string, Partial<KeyWrapAad>]>([
    ['another principal', { principalId: 'other' }],
    ['another project', { projectId: 'other' }],
    ['another subject', { subjectId: 'other' }],
    ['another schema version', { schemaVersion: 2 }],
  ])('decrypt with the wrong context fails: %s', async (_label, change) => {
    const { manager } = setup();
    const { wrapped, kekId } = await manager.wrap(DEK, AAD);
    await expect(manager.unwrap(wrapped, kekId, { ...AAD, ...change })).rejects.toBeInstanceOf(
      KeyManagerRefusedError,
    );
  });

  it('never sends a context value that is not an identifier, or a key of the wrong size', async () => {
    const { client, manager } = setup();
    await expect(
      manager.wrap(DEK, { ...AAD, subjectId: 'jane@example.com' }),
    ).rejects.toBeInstanceOf(KeyManagerInputError);
    await expect(
      manager.unwrap(new Uint8Array(40), KEK, { ...AAD, projectId: 'has space' }),
    ).rejects.toBeInstanceOf(KeyManagerInputError);
    await expect(manager.wrap(new Uint8Array(31), AAD)).rejects.toBeInstanceOf(
      KeyManagerInputError,
    );
    expect(client.calls).toEqual([]);
  });

  it.each([
    ['ThrottlingException', KeyManagerUnavailableError],
    ['KMSInternalException', KeyManagerUnavailableError],
    ['SomethingNew', KeyManagerUnavailableError],
    ['AccessDeniedException', KeyManagerRefusedError],
    ['DisabledException', KeyManagerRefusedError],
    ['KMSInvalidStateException', KeyManagerRefusedError],
    ['NotFoundException', KeyManagerRefusedError],
  ])('maps %s, keeping nothing of the vendor', async (errorName, expected) => {
    const { client, manager } = setup();
    client.failNext(errorName, 'encrypt');
    const failure: unknown = await manager.wrap(DEK, AAD).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(expected);
    expect(String(failure)).not.toContain(errorName);
    const { wrapped, kekId } = await manager.wrap(DEK, AAD);
    client.failNext(errorName, 'decrypt');
    await expect(manager.unwrap(wrapped, kekId, AAD)).rejects.toBeInstanceOf(expected);
  });

  it('passes on a caller that has given up as unavailable', async () => {
    const { manager } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(manager.wrap(DEK, AAD, { signal: controller.signal })).rejects.toBeInstanceOf(
      KeyManagerUnavailableError,
    );
  });

  it('refuses to start with no key', () => {
    const client = new FakeKmsClient();
    expect(() => new AwsKmsKeyManager({ client, kekId: '', timeoutMs: 5_000 })).toThrow(
      KeyManagerInputError,
    );
  });
});
