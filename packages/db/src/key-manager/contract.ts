// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The suite every key manager must pass before it can protect personal data.
// A factory gives the backend under test and a second one whose current key
// is new but which still holds the first one's, which is what a rotation
// leaves behind.

import { beforeAll, describe, expect, it } from 'vitest';

import { KeyManagerInputError, KeyManagerRefusedError } from './port.js';
import type { KeyManager, KeyWrapAad } from './port.js';

export interface KeyManagerUnderTest {
  readonly keyManager: KeyManager;
  /** The same backend after a rotation: a new current key, the old one still usable. */
  readonly rotated: KeyManager;
}

const AAD: KeyWrapAad = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41',
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f',
  subjectId: 'subject-1',
  schemaVersion: 1,
};
const DEK = new Uint8Array(32).fill(5);

/** Registers the contract suite for one backend; `factory` runs once. */
export function describeKeyManager(
  name: string,
  factory: () => KeyManagerUnderTest | Promise<KeyManagerUnderTest>,
): void {
  describe(`key manager contract: ${name}`, () => {
    let keyManager: KeyManager;
    let rotated: KeyManager;

    beforeAll(async () => {
      ({ keyManager, rotated } = await factory());
    });

    it('round trips a data key, naming the current key', async () => {
      const { wrapped, kekId } = await keyManager.wrap(DEK, AAD);
      expect(kekId).toBe(keyManager.currentKekId);
      expect(Buffer.from(wrapped).includes(Buffer.from(DEK))).toBe(false);
      expect(await keyManager.unwrap(wrapped, kekId, AAD)).toEqual(DEK);
    });

    it('wraps the same key differently each time', async () => {
      const first = await keyManager.wrap(DEK, AAD);
      const second = await keyManager.wrap(DEK, AAD);
      expect(first.wrapped).not.toEqual(second.wrapped);
    });

    it.each<[string, Partial<KeyWrapAad>]>([
      ['another principal', { principalId: 'another-principal' }],
      ['another project', { projectId: 'another-project' }],
      ['another subject', { subjectId: 'another-subject' }],
      ['another schema version', { schemaVersion: 2 }],
    ])('wrong aad fails: %s', async (_label, change) => {
      const { wrapped, kekId } = await keyManager.wrap(DEK, AAD);
      await expect(keyManager.unwrap(wrapped, kekId, { ...AAD, ...change })).rejects.toBeInstanceOf(
        KeyManagerRefusedError,
      );
    });

    it('unknown key id fails', async () => {
      const { wrapped } = await keyManager.wrap(DEK, AAD);
      await expect(keyManager.unwrap(wrapped, 'no-such-key', AAD)).rejects.toBeInstanceOf(
        KeyManagerRefusedError,
      );
    });

    it('damaged bytes fail', async () => {
      const { wrapped, kekId } = await keyManager.wrap(DEK, AAD);
      const damaged = Uint8Array.from(wrapped);
      damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
      await expect(keyManager.unwrap(damaged, kekId, AAD)).rejects.toBeInstanceOf(
        KeyManagerRefusedError,
      );
    });

    it('unwrap with a previous kek id', async () => {
      const old = await keyManager.wrap(DEK, AAD);
      expect(rotated.currentKekId).not.toBe(keyManager.currentKekId);
      expect(await rotated.unwrap(old.wrapped, old.kekId, AAD)).toEqual(DEK);
      const fresh = await rotated.wrap(DEK, AAD);
      expect(fresh.kekId).toBe(rotated.currentKekId);
      expect(await rotated.unwrap(fresh.wrapped, fresh.kekId, AAD)).toEqual(DEK);
    });

    it.each<[string, Partial<KeyWrapAad>]>([
      ['an email as subject', { subjectId: 'jane@example.com' }],
      ['an empty principal', { principalId: '' }],
      ['a project with a space', { projectId: 'has space' }],
      ['a schema version of zero', { schemaVersion: 0 }],
      ['a fractional schema version', { schemaVersion: 1.5 }],
    ])('refuses associated data that is not identifiers: %s', async (_label, change) => {
      await expect(keyManager.wrap(DEK, { ...AAD, ...change })).rejects.toBeInstanceOf(
        KeyManagerInputError,
      );
    });
  });
}
