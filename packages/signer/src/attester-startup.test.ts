// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the attester's startup check (attester-startup.ts).
 *
 * verifyAttesterStartup({ signer, networks, nodeEnv, opts }) refuses to start
 * with SignerDeniedError when the attester's key on any of the networks is one
 * of the public test keys, in any environment but a test.
 */

import {
  PUBLIC_TEST_ATTESTER_KEYS,
  SignerDeniedError,
  SignerUnavailableError,
} from '@ujira/chain-adapter';
import type { CallOptions, NetworkId, SignerRef } from '@ujira/chain-adapter';
import { encodeAccountAddress } from '@ujira/chain-adapter/codecs';
import { describe, expect, it } from 'vitest';

import { LocalSigner, verifyAttesterStartup } from './index.js';

const OPTS: CallOptions = { correlationId: 'attester-startup-test' };
const TESTNET: NetworkId = 'stellar:testnet';
const PUBNET: NetworkId = 'stellar:pubnet';

const accountOf = (key: string) => encodeAccountAddress(Uint8Array.from(Buffer.from(key, 'hex')));

/** A key manager holding this key for every network it is asked about. */
const holding = (key: string, only?: NetworkId) => ({
  address: (ref: SignerRef) =>
    Promise.resolve({
      network: ref.network,
      value: accountOf(only === undefined || ref.network === only ? key : '11'.repeat(32)),
    }),
});

describe('verifyAttesterStartup', () => {
  describe.each(PUBLIC_TEST_ATTESTER_KEYS)('configured with the public test key %s', (key) => {
    it.each(['production', 'staging', 'development', ''])(
      'refuses to start when the environment is "%s"',
      async (nodeEnv) => {
        const run = verifyAttesterStartup({
          signer: holding(key),
          networks: [TESTNET],
          nodeEnv,
          opts: OPTS,
        });
        await expect(run).rejects.toBeInstanceOf(SignerDeniedError);
        await expect(run).rejects.toMatchObject({ network: TESTNET });
      },
    );

    it('starts in a test', async () => {
      await expect(
        verifyAttesterStartup({
          signer: holding(key),
          networks: [TESTNET],
          nodeEnv: 'test',
          opts: OPTS,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it('refuses a test key on any network it attests on, not only the first', async () => {
    const [key = ''] = PUBLIC_TEST_ATTESTER_KEYS;
    const run = verifyAttesterStartup({
      signer: holding(key, PUBNET),
      networks: [TESTNET, PUBNET],
      nodeEnv: 'production',
      opts: OPTS,
    });
    await expect(run).rejects.toMatchObject({ code: 'SIGNER_DENIED', network: PUBNET });
  });

  it('starts in any environment with a key of its own', async () => {
    const signer = new LocalSigner({ seed: '3c'.repeat(32), nodeEnv: 'test' });
    await expect(
      verifyAttesterStartup({ signer, networks: [TESTNET], nodeEnv: 'production', opts: OPTS }),
    ).resolves.toBeUndefined();
  });

  it('reads the environment from the process when none is given; vitest sets test', async () => {
    const [key = ''] = PUBLIC_TEST_ATTESTER_KEYS;
    await expect(
      verifyAttesterStartup({ signer: holding(key), networks: [TESTNET], opts: OPTS }),
    ).resolves.toBeUndefined();
  });

  it("lets the signer's own failure through, and does not start", async () => {
    const failure = new SignerUnavailableError();
    await expect(
      verifyAttesterStartup({
        signer: { address: () => Promise.reject(failure) },
        networks: [TESTNET],
        nodeEnv: 'production',
        opts: OPTS,
      }),
    ).rejects.toBe(failure);
  });
});
