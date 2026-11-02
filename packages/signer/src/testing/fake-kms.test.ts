// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fake behaves as the backends rely on the service to: ciphertext is
// bound to its key and its encryption context, a chosen failure fires once on
// the matching call, and a caller that has given up gets no answer.

import { describe, expect, it } from 'vitest';

import { KmsCallError } from '../aws-kms/client.js';
import { FakeKmsClient } from './fake-kms.js';

const CALL = { signal: new AbortController().signal };
const CONTEXT = { principal_id: 'p', subject_id: 's' };
const PLAINTEXT = Uint8Array.of(1, 2, 3);

describe('FakeKmsClient', () => {
  it('round trips under the same key and context', async () => {
    const client = new FakeKmsClient();
    const { ciphertext, keyId } = await client.encrypt('k', PLAINTEXT, CONTEXT, CALL);
    expect(keyId).toBe('k');
    expect(ciphertext).not.toEqual(PLAINTEXT);
    expect(await client.decrypt('k', ciphertext, CONTEXT, CALL)).toEqual(PLAINTEXT);
    // The order the pairs were written in does not matter.
    const reordered = { subject_id: 's', principal_id: 'p' };
    expect(await client.decrypt('k', ciphertext, reordered, CALL)).toEqual(PLAINTEXT);
  });

  it('refuses another context or another key, as the service does', async () => {
    const client = new FakeKmsClient();
    const { ciphertext } = await client.encrypt('k', PLAINTEXT, CONTEXT, CALL);
    const refused = { errorName: 'InvalidCiphertextException' };
    await expect(
      client.decrypt('k', ciphertext, { principal_id: 'x' }, CALL),
    ).rejects.toMatchObject(refused);
    await expect(client.decrypt('other', ciphertext, CONTEXT, CALL)).rejects.toMatchObject(refused);
  });

  it('fails the next matching call once, and records every call', async () => {
    const client = new FakeKmsClient();
    client.failNext('ThrottlingException', 'decrypt');
    const { ciphertext } = await client.encrypt('k', PLAINTEXT, CONTEXT, CALL);
    await expect(client.decrypt('k', ciphertext, CONTEXT, CALL)).rejects.toBeInstanceOf(
      KmsCallError,
    );
    expect(await client.decrypt('k', ciphertext, CONTEXT, CALL)).toEqual(PLAINTEXT);
    client.failNext('DisabledException');
    await expect(client.encrypt('k', PLAINTEXT, CONTEXT, CALL)).rejects.toMatchObject({
      errorName: 'DisabledException',
    });
    expect(client.calls.map((c) => c.operation)).toEqual([
      'encrypt',
      'decrypt',
      'decrypt',
      'encrypt',
    ]);
  });

  it('answers nothing once the caller has given up', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new FakeKmsClient().getPublicKey('k', { signal: controller.signal }),
    ).rejects.toMatchObject({ errorName: 'AbortError' });
  });
});
