// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// configKeyResolver serves the keys configuration pins for this provider,
// plus any given to it, by ref. A key pinned under another provider resolves
// to nothing, and a ref with no key falls through to the fallback.

import { encodeAccountAddress } from '@ujira/chain-adapter/codecs';
import { parseNetworksConfig } from '@ujira/chain-adapter';
import type { CallOptions, SignerRef, Uuid } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { configKeyResolver } from './index.js';

const OPTS: CallOptions = { correlationId: 'aws-kms-keys-test' };
const NETWORK = 'stellar:testnet';
const FACTORY = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SAC = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';

const key = (provider: string, keyId: string, fill: number) => ({
  provider,
  keyId,
  address: encodeAccountAddress(new Uint8Array(32).fill(fill)),
});

const CONFIG = parseNetworksConfig({
  [NETWORK]: {
    enabled: true,
    rpc: [{ url: 'secretRef:stellar_rpc', weight: 1 }],
    maxEndpointLagSeconds: 15,
    trustedFactories: { '1': [FACTORY] },
    assets: { USDC: { sac: SAC, issuer: ISSUER } },
    deposits: { startLedger: 0, availableAt: 'included', pageEvents: 500 },
    executor: {
      txValiditySeconds: 60,
      keys: [key('aws_kms', 'kms-executor', 1), key('local', 'local-executor', 2)],
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
      key: key('aws_kms', 'kms-sponsor', 3),
    },
    sep10: [{ anchorId: 'anchor.example', key: key('aws_kms', 'kms-sep10', 4) }],
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

const ID = '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid;
const AGENT: SignerRef = {
  kind: 'managed_agent',
  network: NETWORK,
  scope: { principalId: ID, projectId: ID },
  agentId: ID,
};
const ATTESTER: SignerRef = { kind: 'attester', network: NETWORK };

describe('configKeyResolver', () => {
  it('serves the keys pinned for this provider, by ref', async () => {
    const keyFor = configKeyResolver(CONFIG);
    expect(await keyFor({ kind: 'executor', network: NETWORK, keyId: 'kms-executor' }, OPTS)).toBe(
      'kms-executor',
    );
    expect(await keyFor({ kind: 'fee_sponsor', network: NETWORK }, OPTS)).toBe('kms-sponsor');
    expect(
      await keyFor({ kind: 'sep10', network: NETWORK, anchorId: 'anchor.example' }, OPTS),
    ).toBe('kms-sep10');
  });

  it('resolves nothing for a key under another provider or another network', async () => {
    const keyFor = configKeyResolver(CONFIG);
    expect(
      await keyFor({ kind: 'executor', network: NETWORK, keyId: 'local-executor' }, OPTS),
    ).toBeNull();
    expect(await keyFor({ kind: 'fee_sponsor', network: 'stellar:pubnet' }, OPTS)).toBeNull();
    expect(await keyFor(ATTESTER, OPTS)).toBeNull();
  });

  it('adds keys configuration does not pin, and asks the fallback for the rest', async () => {
    const keyFor = configKeyResolver(CONFIG, [{ ref: ATTESTER, keyId: 'kms-attester' }], (ref) =>
      Promise.resolve(ref.kind === 'managed_agent' ? 'kms-agent' : null),
    );
    expect(await keyFor(ATTESTER, OPTS)).toBe('kms-attester');
    expect(await keyFor(AGENT, OPTS)).toBe('kms-agent');
  });
});
