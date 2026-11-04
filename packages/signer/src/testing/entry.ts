// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the entry point tests share: a networks document, the environment of a
// service, and tokens built here so they never read as real ones.

import type { CallOptions, NetworkId, SignerRef } from '@ujira/chain-adapter';

import { LocalSigner } from '../local-signer.js';

const FACTORY = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SAC = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';
const OPTS: CallOptions = { correlationId: 'entry-test' };

export const NETWORK: NetworkId = 'stellar:testnet';
export const ENTRY_SEED = '3c'.repeat(32);
export const PAYOUTS_TOKEN = `payouts-${'p'.repeat(40)}`;
export const ADAPTER_TOKEN = `adapter-${'a'.repeat(40)}`;
export const IDENTITY_TOKEN = `identity-${'i'.repeat(40)}`;

/** The service tokens for every caller of every service. */
export const CALLER_TOKENS = Object.freeze({
  UJIRA_SIGNER_TOKEN_PAYOUTS: PAYOUTS_TOKEN,
  UJIRA_SIGNER_TOKEN_ADAPTER: ADAPTER_TOKEN,
  UJIRA_SIGNER_TOKEN_IDENTITY: IDENTITY_TOKEN,
});

const signer = new LocalSigner({ seed: ENTRY_SEED, nodeEnv: 'test' });

/**
 * A networks document whose pins are the local signer's own addresses for
 * ENTRY_SEED, so a local backend starts, with `wrongSponsor` replacing the fee
 * sponsor's pin when given.
 */
export async function networksDocument(
  options: { readonly provider?: string; readonly wrongSponsor?: string } = {},
): Promise<string> {
  const provider = options.provider ?? 'local';
  const key = async (keyId: string, ref: SignerRef) => ({
    provider,
    keyId,
    address: (await signer.address(ref, OPTS)).value,
  });
  const sponsor = await key('fee_sponsor', { kind: 'fee_sponsor', network: NETWORK });
  return JSON.stringify({
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
        key:
          options.wrongSponsor === undefined
            ? sponsor
            : { ...sponsor, address: options.wrongSponsor },
      },
      sep10: [],
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

/** The SubjectPublicKeyInfo KMS returns for an Ed25519 public key in hex. */
export function spkiOf(publicKeyHex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(`302a300506032b6570032100${publicKeyHex}`, 'hex'));
}
