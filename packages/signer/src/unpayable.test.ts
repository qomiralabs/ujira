// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the backends that hold a key. Before signing, the attester
 * refuses a destination whose base address is the mandate, that mandate's
 * settlement asset contract, or an all-zero address, whatever the tag. The
 * refusal is DestinationInvalidError, so a caller can tell it from a signing
 * failure, and no key is used.
 */

import { DestinationInvalidError, SignerDeniedError } from '@ujira/chain-adapter';
import type { AttesterSigner, CallOptions, SignerRef } from '@ujira/chain-adapter';
import { TEST_DESTINATION, contractAddress } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { AwsKmsAttesterSigner } from './aws-kms/index.js';
import { keyLabel } from './keys.js';
import { LocalAttesterSigner, LocalSigner } from './local-signer.js';
import { FakeKmsClient } from './testing/fake-kms.js';
import { TEST_SEED } from './testing/service.js';
import {
  PAYABLE,
  TEST_ASSET,
  TEST_MANDATES,
  UNPAYABLE,
  UNPAYABLE_FROM_FIELDS,
  attestationTo,
} from './testing/unpayable.js';

const OPTS: CallOptions = { correlationId: 'unpayable-test' };
const ATTESTER: SignerRef = { kind: 'attester', network: 'stellar:testnet' };

interface KeyHolder {
  readonly attester: AttesterSigner;
  /** How many times the key has been used. */
  readonly signatures: () => number;
}

function local(): KeyHolder {
  // The local backend starts its latency clock as it starts to sign, which is
  // the one thing it does on the way to the key that a test can see.
  let reads = 0;
  const attester = new LocalAttesterSigner({
    seed: TEST_SEED,
    nodeEnv: 'test',
    mandates: TEST_MANDATES,
    now: () => {
      reads += 1;
      return 0;
    },
  });
  return { attester, signatures: () => reads };
}

function kms(): KeyHolder {
  const client = new FakeKmsClient();
  const attester = new AwsKmsAttesterSigner({
    client,
    keyFor: (ref) => Promise.resolve(keyLabel(ref)),
    timeoutMs: 5_000,
    mandates: TEST_MANDATES,
  });
  return {
    attester,
    signatures: () => client.calls.filter((call) => call.operation === 'sign').length,
  };
}

describe.each([
  ['the local attester', local],
  ['the KMS attester', kms],
])('%s', (_name, holder) => {
  it.each(UNPAYABLE)('refuses %s and signs nothing', async (_label, address, tag) => {
    const { attester, signatures } = holder();
    await expect(
      attester.signAttestation(attestationTo(address, tag), OPTS),
    ).rejects.toBeInstanceOf(DestinationInvalidError);
    expect(signatures()).toBe(0);
  });

  it.each(PAYABLE)('still signs for %s', async (_label, address, tag) => {
    const { attester, signatures } = holder();
    const result = await attester.signAttestation(attestationTo(address, tag), OPTS);
    expect(result.signature).toHaveLength(64);
    expect(signatures()).toBeGreaterThan(0);
  });

  it('refuses a mandate the index does not know, since its asset cannot be ruled out', async () => {
    const { attester, signatures } = holder();
    const fields = attestationTo(TEST_DESTINATION, null);
    const stranger = contractAddress(new Uint8Array(32).fill(0x31));
    await expect(
      attester.signAttestation(
        {
          ...fields,
          mandate: { ...fields.mandate, address: { ...fields.mandate.address, value: stranger } },
        },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(SignerDeniedError);
    expect(signatures()).toBe(0);
  });
});

describe('a key behind the provider port', () => {
  it.each(UNPAYABLE_FROM_FIELDS)('refuses %s', async (_label, address, tag) => {
    const signer = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
    await expect(
      signer.sign(
        ATTESTER,
        { kind: 'attestation', network: ATTESTER.network, fields: attestationTo(address, tag) },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(DestinationInvalidError);
  });

  it('leaves the settlement asset to the policy that can look it up', async () => {
    const signer = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
    const result = await signer.sign(
      ATTESTER,
      { kind: 'attestation', network: ATTESTER.network, fields: attestationTo(TEST_ASSET, null) },
      OPTS,
    );
    expect(result.signature).toHaveLength(64);
  });
});
