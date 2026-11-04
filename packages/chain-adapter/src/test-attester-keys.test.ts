// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PUBLIC_TEST_ATTESTER_KEYS, isPublicTestAttesterKey } from './test-attester-keys.js';

const FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../vendor/attestation-parity/fixture.json'),
    'utf8',
  ),
) as {
  readonly keys: {
    readonly attester: { readonly public_key: string };
    readonly other_signer: { readonly public_key: string };
  };
};

const bytesOf = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

describe('the public test attester keys', () => {
  it('are the two keys the vendored fixture signs with, so they cannot drift apart', () => {
    expect([...PUBLIC_TEST_ATTESTER_KEYS].sort()).toEqual(
      [FIXTURE.keys.attester.public_key, FIXTURE.keys.other_signer.public_key]
        .map((key) => key.slice(2))
        .sort(),
    );
  });

  it.each(PUBLIC_TEST_ATTESTER_KEYS)('recognizes %s', (key) => {
    expect(isPublicTestAttesterKey(bytesOf(key))).toBe(true);
  });

  it('does not recognize any other key, or a value that is no key', () => {
    expect(isPublicTestAttesterKey(new Uint8Array(32).fill(9))).toBe(false);
    expect(isPublicTestAttesterKey(new Uint8Array(0))).toBe(false);
    expect(isPublicTestAttesterKey('raw' as unknown as Uint8Array)).toBe(false);
    expect(isPublicTestAttesterKey(null as unknown as Uint8Array)).toBe(false);
  });
});
