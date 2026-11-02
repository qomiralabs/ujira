// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// keyLabel gives every ref that names a key its own label, and refuses an
// external ref with SignerDeniedError. deriveKey is deterministic in the
// seed and the label, and its public key is the ed25519 key of its secret.

import { SignerDeniedError } from '@ujira/chain-adapter';
import type { SignerRef, Uuid } from '@ujira/chain-adapter';
import { ed25519PublicKey } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { deriveKey, keyLabel, parseLocalSeed } from './keys.js';

const NETWORK = 'stellar:testnet' as const;
const ID = '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid;

describe('local keys', () => {
  it('labels every ref apart, including fields that could run together', () => {
    const refs: SignerRef[] = [
      { kind: 'executor', network: NETWORK, keyId: 'a' },
      { kind: 'executor', network: NETWORK, keyId: 'a"]' },
      { kind: 'fee_sponsor', network: NETWORK },
      { kind: 'attester', network: NETWORK },
      { kind: 'sep10', network: NETWORK, anchorId: 'a' },
      {
        kind: 'managed_agent',
        network: NETWORK,
        scope: { principalId: ID, projectId: ID },
        agentId: ID,
      },
    ];
    const labels = refs.map(keyLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('has no key for an external signer', () => {
    expect(() =>
      keyLabel({
        kind: 'external',
        network: NETWORK,
        role: 'principal',
        address: { network: NETWORK, value: 'G' },
      }),
    ).toThrow(SignerDeniedError);
  });

  it('derives the same key from the same seed and label, and its public key', () => {
    const seed = parseLocalSeed('3c'.repeat(32));
    const a = deriveKey(seed, 'x');
    expect(deriveKey(seed, 'x')).toEqual(a);
    expect(deriveKey(seed, 'y').secretKey).not.toEqual(a.secretKey);
    expect(a.publicKey).toEqual(ed25519PublicKey(a.secretKey));
  });
});
