// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the local key manager (key-manager/local.ts). It passes the
 * suite every backend must. It refuses to start in production, reads its keys
 * from UJIRA_PII_LOCAL_KEK with the current key first, and never shows a key
 * in an error, in JSON or on inspection. A data key must be 32 bytes.
 */

import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { describeKeyManager } from './contract.js';
import { KeyManagerInputError, LOCAL_KEK_VARIABLE, LocalKeyManager } from './index.js';

const FIRST = `first:${'a1'.repeat(32)}`;
const SECOND = `second:${'b2'.repeat(32)}`;
const AAD = { principalId: 'p', projectId: 'q', subjectId: 's', schemaVersion: 1 };

describeKeyManager('LocalKeyManager', () => ({
  keyManager: new LocalKeyManager({ keks: FIRST, nodeEnv: 'test' }),
  rotated: new LocalKeyManager({ keks: `${SECOND},${FIRST}`, nodeEnv: 'test' }),
}));

describe('LocalKeyManager', () => {
  it('NODE_ENV production throws', () => {
    expect(() => new LocalKeyManager({ keks: FIRST, nodeEnv: 'production' })).toThrow(
      KeyManagerInputError,
    );
    expect(() =>
      LocalKeyManager.fromEnv({ [LOCAL_KEK_VARIABLE]: FIRST, NODE_ENV: 'production' }),
    ).toThrow(KeyManagerInputError);
  });

  it('reads its keys from the environment, the current key first', () => {
    const manager = LocalKeyManager.fromEnv({
      [LOCAL_KEK_VARIABLE]: `${SECOND},${FIRST}`,
      NODE_ENV: 'development',
    });
    expect(manager.currentKekId).toBe('second');
    // With no NODE_ENV given, the process's is used; vitest sets test.
    expect(new LocalKeyManager({ keks: FIRST }).currentKekId).toBe('first');
  });

  it.each([
    ['nothing', undefined],
    ['a bare key with no id', 'a1'.repeat(32)],
    ['a short key', `first:${'a1'.repeat(31)}`],
    ['upper case hex', `first:${'A1'.repeat(32)}`],
    ['the same id twice', `${FIRST},${FIRST}`],
  ])('refuses %s without showing it', (_label, keks) => {
    let error: unknown;
    try {
      LocalKeyManager.fromEnv({ [LOCAL_KEK_VARIABLE]: keks, NODE_ENV: 'test' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(KeyManagerInputError);
    expect((error as Error).message).toContain(LOCAL_KEK_VARIABLE);
    expect((error as Error).message).not.toContain('a1a1');
    expect((error as Error).message).not.toContain('A1A1');
  });

  it('never shows a key', () => {
    const manager = new LocalKeyManager({ keks: FIRST, nodeEnv: 'test' });
    expect(JSON.stringify(manager)).not.toContain('a1a1');
    expect(inspect(manager, { depth: 10, showHidden: true })).not.toContain('a1a1');
  });

  it.each([
    ['31 bytes', new Uint8Array(31)],
    ['33 bytes', new Uint8Array(33)],
    ['text', 'not bytes'],
  ])('refuses a data key of %s', async (_label, dek) => {
    const manager = new LocalKeyManager({ keks: FIRST, nodeEnv: 'test' });
    await expect(manager.wrap(dek as Uint8Array, AAD)).rejects.toBeInstanceOf(KeyManagerInputError);
  });
});
