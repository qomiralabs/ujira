// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the startup check (startup.ts).
 *
 * verifySignerStartup({ signer, config, nodeEnv, opts }) resolves when the
 * service may start. In production any pinned key whose provider is local
 * throws SignerDeniedError before the signer is asked anything. Then every
 * pinned address must equal the one the signer derives for its ref, or it
 * throws SignerAddressMismatchError (SIGNER_ADDRESS_MISMATCH).
 */

import {
  SignerAddressMismatchError,
  SignerDeniedError,
  parseNetworksConfig,
} from '@ujira/chain-adapter';
import type { CallOptions, ChainAddress, SignerProvider, SignerRef } from '@ujira/chain-adapter';
import { describe, expect, it, vi } from 'vitest';

import { LOCAL_PROVIDER, LocalSigner, verifySignerStartup } from './index.js';

const FACTORY = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SAC = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';
const OPTS: CallOptions = { correlationId: 'startup-test' };
const NETWORK = 'stellar:testnet' as const;

const signer = new LocalSigner({ seed: '3c'.repeat(32), nodeEnv: 'test' });

async function pinned(ref: SignerRef): Promise<string> {
  return (await signer.address(ref, OPTS)).value;
}

// A testnet section whose pins are the local signer's own addresses, with
// `wrong` replacing the fee sponsor's when given.
async function config(options: { provider?: string; wrong?: string } = {}) {
  const provider = options.provider ?? LOCAL_PROVIDER;
  const key = async (keyId: string, ref: SignerRef) => ({
    provider,
    keyId,
    address: await pinned(ref),
  });
  const sponsor = await key('fee_sponsor', { kind: 'fee_sponsor', network: NETWORK });
  return parseNetworksConfig({
    [NETWORK]: {
      enabled: true,
      rpc: [{ url: 'secretRef:stellar_rpc', weight: 1 }],
      maxEndpointLagSeconds: 15,
      trustedFactories: { '1': [FACTORY] },
      assets: { USDC: { sac: SAC, issuer: ISSUER } },
      deposits: { startLedger: 0, availableAt: 'included', pageEvents: 500 },
      executor: {
        txValiditySeconds: 60,
        keys: [
          await key('executor_0', { kind: 'executor', network: NETWORK, keyId: 'executor_0' }),
          await key('executor_1', { kind: 'executor', network: NETWORK, keyId: 'executor_1' }),
        ],
      },
      feeSponsor: {
        perPrincipalFundingAccounts: 1,
        reserveSponsorshipDailyStroops: '500000000',
        maxFeePerTxStroops: '1000000',
        perPrincipalPerMinute: 10,
        perPrincipalDailyCount: 200,
        perPrincipalDailyFeeStroops: '50000000',
        globalDailyFeeStroops: '5000000000',
        lowBalanceStroops: '1000000000',
        minBalanceStroops: '100000000',
        key: options.wrong === undefined ? sponsor : { ...sponsor, address: options.wrong },
      },
      sep10: [
        {
          anchorId: 'anchor.example',
          key: await key('sep10_anchor', {
            kind: 'sep10',
            network: NETWORK,
            anchorId: 'anchor.example',
          }),
        },
      ],
      signingWindowSeconds: 300,
      explorer: { tx: 'https://stellar.expert/explorer/testnet/tx/{hash}' },
      health: {
        maxHeadLagSeconds: 30,
        degradedErrorBps: 500,
        downErrorBps: 5000,
        hysteresisChecks: 3,
      },
    },
  });
}

describe('verifySignerStartup', () => {
  it('starts when every pin is the signer own address', async () => {
    await expect(
      verifySignerStartup({ signer, config: await config(), nodeEnv: 'development', opts: OPTS }),
    ).resolves.toBeUndefined();
  });

  it('wrong pinned address raises SIGNER_ADDRESS_MISMATCH', async () => {
    const wrong = await pinned({ kind: 'executor', network: NETWORK, keyId: 'executor_9' });
    const run = verifySignerStartup({
      signer,
      config: await config({ wrong }),
      nodeEnv: 'development',
      opts: OPTS,
    });
    await expect(run).rejects.toBeInstanceOf(SignerAddressMismatchError);
    await expect(run).rejects.toMatchObject({ code: 'SIGNER_ADDRESS_MISMATCH', network: NETWORK });
  });

  it('refuses a local key in production before asking the signer anything', async () => {
    const address = vi.fn<SignerProvider['address']>();
    const spy: SignerProvider = { sign: vi.fn(), address, health: vi.fn() };
    const run = verifySignerStartup({
      signer: spy,
      config: await config(),
      nodeEnv: 'production',
      opts: OPTS,
    });
    await expect(run).rejects.toBeInstanceOf(SignerDeniedError);
    expect(address).not.toHaveBeenCalled();
  });

  it('checks the pins of keys held elsewhere in production', async () => {
    const pins = await config({ provider: 'kms' });
    // A stand in for a remote backend that serves the same addresses.
    const remote: SignerProvider = {
      sign: vi.fn(),
      health: vi.fn(),
      address: (ref: SignerRef): Promise<ChainAddress> => signer.address(ref, OPTS),
    };
    await expect(
      verifySignerStartup({ signer: remote, config: pins, nodeEnv: 'production', opts: OPTS }),
    ).resolves.toBeUndefined();
    // With no environment given, the process's is used; vitest sets test.
    await expect(
      verifySignerStartup({ signer, config: pins, opts: OPTS }),
    ).resolves.toBeUndefined();
  });

  it('skips networks the config leaves out', async () => {
    await expect(
      verifySignerStartup({
        signer,
        config: parseNetworksConfig({}),
        nodeEnv: 'production',
        opts: OPTS,
      }),
    ).resolves.toBeUndefined();
  });
});
