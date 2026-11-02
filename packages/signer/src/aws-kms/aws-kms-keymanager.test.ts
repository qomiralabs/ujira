// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the KMS key manager (aws-kms/key-manager.ts), against a fake
 * client. No account, credentials or network are involved.
 *
 * wrap encrypts with the current key under the encryption context
 * { principal_id, project_id, subject_id, schema_version }; unwrap decrypts
 * with the stored key id under the same context, and any other context is
 * refused. A context value that is not an identifier never reaches KMS.
 */

import { InvalidInputError, SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { FakeKmsClient } from '../testing/fake-kms.js';
import { AwsKmsKeyManager } from './key-manager.js';
import type { WrapContext } from './key-manager.js';

const KEK = 'arn:aws:kms:eu-central-1:000000000000:key/test';
const CONTEXT: WrapContext = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41',
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f',
  subjectId: 'subject-1',
  schemaVersion: 1,
};
const SIGNAL = new AbortController().signal;
const DATA_KEY = new Uint8Array(32).fill(5);

function setup() {
  const client = new FakeKmsClient();
  return { client, manager: new AwsKmsKeyManager({ client, kekId: KEK }) };
}

describe('AwsKmsKeyManager', () => {
  it('round trips a data key, naming the key that wrapped it', async () => {
    const { manager } = setup();
    expect(manager.currentKekId).toBe(KEK);
    const wrapped = await manager.wrap(DATA_KEY, CONTEXT, SIGNAL);
    expect(wrapped.kekId).toBe(KEK);
    expect(wrapped.ciphertext).not.toEqual(DATA_KEY);
    expect(await manager.unwrap(wrapped, CONTEXT, SIGNAL)).toEqual(DATA_KEY);
  });

  it.each<[string, Partial<WrapContext>]>([
    ['another principal', { principalId: 'other' }],
    ['another project', { projectId: 'other' }],
    ['another subject', { subjectId: 'other' }],
    ['another schema version', { schemaVersion: 2 }],
  ])('decrypt with the wrong context fails: %s', async (_label, change) => {
    const { manager } = setup();
    const wrapped = await manager.wrap(DATA_KEY, CONTEXT, SIGNAL);
    await expect(manager.unwrap(wrapped, { ...CONTEXT, ...change }, SIGNAL)).rejects.toBeInstanceOf(
      SignerDeniedError,
    );
  });

  it('keeps decrypting with the stored key id after the current key changes', async () => {
    const client = new FakeKmsClient();
    const old = new AwsKmsKeyManager({ client, kekId: 'old-key' });
    const wrapped = await old.wrap(DATA_KEY, CONTEXT, SIGNAL);
    const current = new AwsKmsKeyManager({ client, kekId: 'new-key' });
    expect(await current.unwrap(wrapped, CONTEXT, SIGNAL)).toEqual(DATA_KEY);
    expect(client.calls.at(-1)).toEqual({ operation: 'decrypt', keyId: 'old-key' });
  });

  it('never sends a context value that is not an identifier', async () => {
    const { client, manager } = setup();
    const cases: Partial<WrapContext>[] = [
      { subjectId: 'jane@example.com' },
      { principalId: '' },
      { projectId: 'has space' },
      { schemaVersion: 0 },
      { schemaVersion: 1.5 },
    ];
    for (const change of cases) {
      await expect(
        manager.wrap(DATA_KEY, { ...CONTEXT, ...change }, SIGNAL),
      ).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(client.calls).toEqual([]);
  });

  it('maps failures to the port errors, keeping nothing of the vendor', async () => {
    const { client, manager } = setup();
    client.failNext('ThrottlingException', 'encrypt');
    await expect(manager.wrap(DATA_KEY, CONTEXT, SIGNAL)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
    client.failNext('AccessDeniedException', 'encrypt');
    await expect(manager.wrap(DATA_KEY, CONTEXT, SIGNAL)).rejects.toBeInstanceOf(SignerDeniedError);
    const wrapped = await manager.wrap(DATA_KEY, CONTEXT, SIGNAL);
    client.failNext('KMSInternalException', 'decrypt');
    await expect(manager.unwrap(wrapped, CONTEXT, SIGNAL)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it('refuses to start with no key', () => {
    const client = new FakeKmsClient();
    expect(() => new AwsKmsKeyManager({ client, kekId: '' })).toThrow(InvalidInputError);
  });
});
