// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Wiring for the adapter's unit tests: config, ports and the fake RPC loaded
// with the recorded testnet mandate. Test code only.

import { Keypair, xdr } from '@stellar/stellar-sdk/base';

import { parseNetworksConfig } from '../config.js';
import type { NetworksConfig } from '../config.js';
import type { AdapterPorts, MandateRef, TenantScope, UnixSeconds, Uuid } from '../types.js';
import { StellarMandateAdapter } from './mandate-adapter.js';
import { createMemorySigningRequestStore } from './requests.js';
import type { SigningRequestStore } from './requests.js';
import { keypairSigner, memoryStore, recordingSponsorship } from './test-ports.js';
import type { MemoryStore, RecordingSponsorship } from './test-ports.js';
import { FIXTURE_FACTORY, FIXTURE_USDC, FakeRpc, loadReadFixture } from './test-rpc.js';
import { accountKey } from './tx.js';

export const NETWORK = 'stellar:testnet' as const;
export const NOW = 1_793_500_000n;

export function networksConfig(overrides: {
  readonly trusted?: readonly string[];
  readonly sponsor: string;
  readonly channel: string;
  readonly maxFeePerTxStroops?: string;
  readonly usdc?: string;
}): NetworksConfig {
  return parseNetworksConfig({
    [NETWORK]: {
      enabled: true,
      rpc: [{ url: 'secretRef:testnet_rpc', weight: 1 }],
      maxEndpointLagSeconds: 60,
      explorer: { tx: 'https://stellar.expert/explorer/testnet/tx/{hash}' },
      health: {
        maxHeadLagSeconds: 60,
        degradedErrorBps: 500,
        downErrorBps: 2000,
        hysteresisChecks: 3,
      },
      trustedFactories: { '1': [...(overrides.trusted ?? [FIXTURE_FACTORY])] },
      assets: {
        USDC: {
          sac: overrides.usdc ?? FIXTURE_USDC,
          issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        },
      },
      deposits: { startLedger: 0, availableAt: 'final', pageEvents: 100 },
      executor: {
        txValiditySeconds: 120,
        keys: [{ provider: 'local', keyId: 'channel-1', address: overrides.channel }],
      },
      feeSponsor: {
        perPrincipalFundingAccounts: 1,
        reserveSponsorshipDailyStroops: '100000000',
        maxFeePerTxStroops: overrides.maxFeePerTxStroops ?? '20000000',
        perPrincipalPerMinute: 60,
        perPrincipalDailyCount: 1000,
        perPrincipalDailyFeeStroops: '100000000',
        globalDailyFeeStroops: '1000000000',
        lowBalanceStroops: '100000000',
        minBalanceStroops: '10000000',
        key: { provider: 'local', keyId: 'sponsor', address: overrides.sponsor },
      },
      sep10: [],
      signingWindowSeconds: 600,
    },
  });
}

/** Adds an account with this sequence number to the fake ledger. */
export function addAccount(rpc: FakeRpc, address: string, sequence: bigint): void {
  const data = xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      balance: 100_000_000n,
      seqNum: sequence,
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: '',
      thresholds: new Uint8Array([1, 0, 0, 0]),
      signers: [],
      ext: xdr.AccountEntryExt.v0(),
    }),
  );
  const key = accountKey(address);
  rpc.entries.set(key, { key, xdr: data.toXdr('base64'), lastModifiedLedgerSeq: 1 });
}

export interface TestSetup {
  readonly adapter: StellarMandateAdapter;
  readonly rpc: FakeRpc;
  readonly store: MemoryStore;
  readonly sponsorship: RecordingSponsorship;
  readonly requests: SigningRequestStore;
  readonly ports: AdapterPorts;
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  readonly principal: Keypair;
  readonly sponsor: Keypair;
  readonly channel: Keypair;
  readonly clock: { now: bigint };
}

export function setup(
  options: {
    readonly trusted?: readonly string[];
    readonly maxFeePerTxStroops?: string;
    readonly usdc?: string;
    readonly deny?: boolean;
    readonly submitTimeoutMs?: number;
  } = {},
): TestSetup {
  const fixture = loadReadFixture();
  const principal = Keypair.random();
  const sponsor = Keypair.random();
  const channel = Keypair.random();
  const rpc = FakeRpc.fromFixture(fixture, { principal: principal.publicKey() });
  addAccount(rpc, principal.publicKey(), 100n);
  addAccount(rpc, channel.publicKey(), 900n);
  const clock = { now: NOW };
  const nowSeconds = () => clock.now as UnixSeconds;
  const config = networksConfig({
    sponsor: sponsor.publicKey(),
    channel: channel.publicKey(),
    ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
    ...(options.maxFeePerTxStroops === undefined
      ? {}
      : { maxFeePerTxStroops: options.maxFeePerTxStroops }),
    ...(options.usdc === undefined ? {} : { usdc: options.usdc }),
  });
  const store = memoryStore(
    NETWORK,
    [{ address: channel.publicKey(), keyId: 'channel-1' }],
    nowSeconds,
  );
  const sponsorship = recordingSponsorship(options.deny ?? false);
  const ports: AdapterPorts = {
    store,
    signer: keypairSigner(
      NETWORK,
      new Map([
        ['fee_sponsor', sponsor],
        ['executor:channel-1', channel],
      ]),
    ),
    sponsorship,
    alerts: { lowBalance: () => undefined, stuck: () => undefined, divergence: () => undefined },
    clock: { nowSeconds },
    config: () => config,
  };
  const requests = createMemorySigningRequestStore();
  let id = 0;
  const adapter = new StellarMandateAdapter({
    network: NETWORK,
    rpc,
    ports,
    requests,
    wait: { attempts: 3, intervalMs: 0, sleep: () => Promise.resolve() },
    ...(options.submitTimeoutMs === undefined ? {} : { submitTimeoutMs: options.submitTimeoutMs }),
    newRequestId: () => `req-${String((id += 1))}`,
  });
  return {
    adapter,
    rpc,
    store,
    sponsorship,
    requests,
    ports,
    scope: fixture.scope as TenantScope & { principalId: Uuid; projectId: Uuid },
    mandate: {
      network: NETWORK,
      address: { network: NETWORK, value: fixture.mandate },
      specVersion: 1,
    },
    principal,
    sponsor,
    channel,
    clock,
  };
}

export const OPTS = { correlationId: 'test-correlation' };
