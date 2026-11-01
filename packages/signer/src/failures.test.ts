// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Failures that working dependencies never produce, forced here. A
// signature that does not verify against the key is never returned: the
// caller gets SignerUnavailableError. An error from a codec that is not a
// refusal of the input is passed on as it is, never turned into a denial
// or swallowed.

import { SignerUnavailableError } from '@ujira/chain-adapter';
import type { CallOptions, SignerRef } from '@ujira/chain-adapter';
import { testTransactionXdr } from '@ujira/chain-adapter/testing';
import type * as Ed25519 from '@noble/curves/ed25519.js';
import type * as Codecs from '@ujira/chain-adapter/codecs';
import { describe, expect, it, vi } from 'vitest';

const failures = vi.hoisted(() => ({ verify: true, decode: false }));

vi.mock('@noble/curves/ed25519.js', async (original) => {
  const real = await original<typeof Ed25519>();
  return {
    ed25519: {
      ...real.ed25519,
      verify: (...args: Parameters<typeof real.ed25519.verify>) =>
        failures.verify && real.ed25519.verify(...args),
    },
  };
});

vi.mock('@ujira/chain-adapter/codecs', async (original) => {
  const real = await original<typeof Codecs>();
  return {
    ...real,
    decodeTransactionEnvelope: (...args: Parameters<typeof real.decodeTransactionEnvelope>) => {
      if (failures.decode) throw new TypeError('decoder fault');
      return real.decodeTransactionEnvelope(...args);
    },
  };
});

const { LocalSigner } = await import('./index.js');

const OPTS: CallOptions = { correlationId: 'signer-failures' };
const EXECUTOR: SignerRef = { kind: 'executor', network: 'stellar:testnet', keyId: 'executor_0' };

describe('forced failures', () => {
  const signer = new LocalSigner({ seed: '3c'.repeat(32), nodeEnv: 'test' });
  const sign = async () =>
    signer.sign(
      EXECUTOR,
      {
        kind: 'stellar_tx',
        network: 'stellar:testnet',
        xdr: testTransactionXdr({ source: (await signer.address(EXECUTOR, OPTS)).value }),
      },
      OPTS,
    );

  it('returns no signature that fails its own verification', async () => {
    failures.verify = false;
    await expect(sign()).rejects.toBeInstanceOf(SignerUnavailableError);
    failures.verify = true;
    await expect(sign()).resolves.toMatchObject({ kind: 'ed25519' });
  });

  it('passes on a codec fault that is not a refusal', async () => {
    failures.decode = true;
    await expect(sign()).rejects.toThrow(TypeError);
    failures.decode = false;
  });
});
