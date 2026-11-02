// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain signer's policy (service/chain-policy.ts), run
 * through the whole service: RemoteSigner, the HTTP handler, the policy and
 * the local backend.
 *
 * Executor: one call to execute or execute_batch on a mandate the index
 * knows with this executor in its role, fee at most the executor cap; an
 * authorization entry for the same call with nothing nested. Fee sponsor:
 * a fee bump whose inner transaction has a reserved fee_bump row, or a
 * reserve sandwich (begin sponsoring X as sponsor, optionally create X with
 * 0 as sponsor, change trust to the payout asset as X, end sponsoring as X,
 * nothing else) valid now for at most 300 s, with a reserved
 * create_funding_account or recipient_activation row for its hash; the fee
 * within the row's and the network's cap. SEP-10: a challenge from the
 * anchor's server account at sequence 0, valid now within 900 s, with only
 * manage data, the first named "<home domain> auth" with a 64 byte nonce
 * and exactly one web_auth_domain from the server. Everything else is
 * SIGNER_DENIED, and the backend is never asked.
 */

import type { NetworkId, SignPayload, SignerRef, Uuid } from '@ujira/chain-adapter';
import { decodeFeeBumpEnvelope, decodeTransactionEnvelope } from '@ujira/chain-adapter/codecs';
import {
  TEST_CONTRACT,
  TEST_DESTINATION,
  TEST_INNER_SOURCE,
  testAuthEntryXdr,
  testFeeBumpXdr,
  testInvokeXdr,
  testReserveSandwichXdr,
  testSep10ChallengeXdr,
} from '@ujira/chain-adapter/testing';
import type { SandwichStep } from '@ujira/chain-adapter/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { OPTS, TEST_SEED, codeOf, harness } from '../testing/service.js';
import type { Harness } from '../testing/service.js';
import { TEST_ASSET } from '../testing/unpayable.js';
import { chainPolicy, memoryMandateIndex, memorySponsorshipLedger } from './index.js';
import type { MemoryReservation, SponsorshipIntent } from './index.js';

const NETWORK: NetworkId = 'stellar:testnet';
const NOW = 1_900_000_000;
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const OTHER_CONTRACT = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const UNINDEXED_CONTRACT = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';
const USDC = { code: 'USDC', issuer: ISSUER };
const SERVER = TEST_INNER_SOURCE;

const EXECUTOR: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };
const SPONSOR: SignerRef = { kind: 'fee_sponsor', network: NETWORK };
const SEP10: SignerRef = { kind: 'sep10', network: NETWORK, anchorId: 'anchor.example' };

interface World {
  readonly service: Harness;
  readonly executor: string;
  readonly sponsor: string;
  readonly client: string;
  readonly reservations: MemoryReservation[];
  readonly reserve: (hash: Uint8Array, intent: SponsorshipIntent, maxFee?: bigint) => void;
}

let world: World;

beforeAll(async () => {
  const keys = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
  const executor = (await keys.address(EXECUTOR, OPTS)).value;
  const sponsor = (await keys.address(SPONSOR, OPTS)).value;
  const client = (await keys.address(SEP10, OPTS)).value;
  const reservations: MemoryReservation[] = [];
  // Another mandate is indexed, but this executor holds no role on it.
  const mandates = memoryMandateIndex([
    {
      network: NETWORK,
      contract: TEST_CONTRACT,
      executors: [executor],
      tenant: TENANT,
      recipientMode: 'allowlist',
      settlementAsset: TEST_ASSET,
    },
    {
      network: NETWORK,
      contract: OTHER_CONTRACT,
      executors: [TEST_DESTINATION],
      tenant: TENANT,
      recipientMode: 'allowlist',
      settlementAsset: TEST_ASSET,
    },
  ]);
  // The ledger is read on each call, so rows pushed later are seen.
  const ledger = {
    reserved: (network: NetworkId, hash: Uint8Array) =>
      memorySponsorshipLedger(reservations).reserved(network, hash, OPTS),
  };
  const service = harness({
    nowSeconds: NOW,
    policy: chainPolicy({
      mandates,
      sponsorships: ledger,
      networks: {
        [NETWORK]: {
          executorMaxFeeStroops: 1_000_000n,
          sponsorMaxFeeStroops: 2_000n,
          payoutAsset: USDC,
          sep10: {
            'anchor.example': {
              serverAccount: SERVER,
              homeDomain: 'anchor.example',
              webAuthDomain: 'auth.anchor.example',
            },
          },
        },
      },
    }),
  });
  world = {
    service,
    executor,
    sponsor,
    client,
    reservations,
    reserve: (txHash, intent, maxFeeStroops = 2_000n) =>
      reservations.push({ network: NETWORK, txHash, intent, tenant: TENANT, maxFeeStroops }),
  };
});

const sign = (ref: SignerRef, payload: SignPayload) =>
  codeOf(world.service.remote.sign(ref, payload, OPTS));
const tx = (xdr: string): SignPayload => ({ kind: 'stellar_tx', network: NETWORK, xdr });

describe('executor payloads', () => {
  const invoke = (functionName: string, extra: Partial<Parameters<typeof testInvokeXdr>[0]> = {}) =>
    tx(
      testInvokeXdr({
        source: world.executor,
        calls: [{ contract: TEST_CONTRACT, functionName }],
        ...extra,
      }),
    );

  it('signs execute and execute_batch on its own mandate', async () => {
    expect(await sign(EXECUTOR, invoke('execute'))).toBe('resolved');
    expect(await sign(EXECUTOR, invoke('execute_batch'))).toBe('resolved');
  });

  it('a withdraw call signed as executor is SIGNER_DENIED', async () => {
    expect(await sign(EXECUTOR, invoke('withdraw'))).toBe('SIGNER_DENIED');
  });

  it('refuses a mandate it holds no role on, or one not indexed', async () => {
    for (const contract of [OTHER_CONTRACT, UNINDEXED_CONTRACT]) {
      const xdr = testInvokeXdr({
        source: world.executor,
        calls: [{ contract, functionName: 'execute' }],
      });
      expect(await sign(EXECUTOR, tx(xdr))).toBe('SIGNER_DENIED');
    }
  });

  it('refuses a fee over the cap, two calls and a payment', async () => {
    expect(await sign(EXECUTOR, invoke('execute', { feePerOperation: 1_000_001 }))).toBe(
      'SIGNER_DENIED',
    );
    const two = testInvokeXdr({
      source: world.executor,
      calls: [
        { contract: TEST_CONTRACT, functionName: 'execute' },
        { contract: TEST_CONTRACT, functionName: 'execute' },
      ],
    });
    expect(await sign(EXECUTOR, tx(two))).toBe('SIGNER_DENIED');
    const sandwich = testReserveSandwichXdr({
      sponsor: world.executor,
      sponsored: TEST_DESTINATION,
      asset: USDC,
    });
    expect(await sign(EXECUTOR, tx(sandwich))).toBe('SIGNER_DENIED');
  });

  it('signs an authorization entry for execute only, with nothing nested', async () => {
    const entry = (functionName: string, nested = false): SignPayload => ({
      kind: 'stellar_auth_entry',
      network: NETWORK,
      entryXdr: testAuthEntryXdr({ address: world.executor, functionName, nested }),
      expirationLedger: 5_000,
    });
    expect(await sign(EXECUTOR, entry('execute'))).toBe('resolved');
    expect(await sign(EXECUTOR, entry('withdraw'))).toBe('SIGNER_DENIED');
    expect(await sign(EXECUTOR, entry('execute', true))).toBe('SIGNER_DENIED');
  });

  it('refuses a payload kind an executor never signs', async () => {
    const bump = testFeeBumpXdr({ feeSource: world.executor });
    expect(await sign(EXECUTOR, { kind: 'stellar_fee_bump', network: NETWORK, xdr: bump })).toBe(
      'SIGNER_DENIED',
    );
  });
});

describe('fee sponsor payloads', () => {
  const bumpPayload = (): { payload: SignPayload; inner: Uint8Array; fee: bigint } => {
    const xdr = testFeeBumpXdr({ feeSource: world.sponsor });
    const decoded = decodeFeeBumpEnvelope(xdr, NETWORK);
    return {
      payload: { kind: 'stellar_fee_bump', network: NETWORK, xdr },
      inner: decoded.inner.hash,
      fee: decoded.fee,
    };
  };

  it('a fee bump without a reservation is SIGNER_DENIED', async () => {
    expect(await sign(SPONSOR, bumpPayload().payload)).toBe('SIGNER_DENIED');
  });

  it('signs a fee bump with a reservation for its inner transaction', async () => {
    const { payload, inner, fee } = bumpPayload();
    world.reserve(inner, 'fee_bump', fee);
    expect(await sign(SPONSOR, payload)).toBe('resolved');
  });

  it('refuses a reservation for another intent, or one below the fee', async () => {
    const xdr = testFeeBumpXdr({ feeSource: world.sponsor, innerSource: TEST_DESTINATION });
    const decoded = decodeFeeBumpEnvelope(xdr, NETWORK);
    const payload: SignPayload = { kind: 'stellar_fee_bump', network: NETWORK, xdr };
    world.reserve(decoded.inner.hash, 'recipient_activation');
    expect(await sign(SPONSOR, payload)).toBe('SIGNER_DENIED');
    world.reservations.pop();
    world.reserve(decoded.inner.hash, 'fee_bump', decoded.fee - 1n);
    expect(await sign(SPONSOR, payload)).toBe('SIGNER_DENIED');
  });

  const sandwich = (
    options: {
      steps?: readonly SandwichStep[];
      asset?: { code: string; issuer: string };
      validitySeconds?: number;
      feePerOperation?: number;
    } = {},
  ) => {
    const xdr = testReserveSandwichXdr({
      sponsor: world.sponsor,
      sponsored: TEST_DESTINATION,
      asset: options.asset ?? USDC,
      ...options,
    });
    const decoded = decodeTransactionEnvelope(xdr, NETWORK);
    const payload: SignPayload = { kind: 'stellar_reserve_sandwich', network: NETWORK, xdr };
    return { payload, hash: decoded.hash };
  };

  it('signs a reserved sandwich, with or without creating the account', async () => {
    const opened = sandwich();
    world.reserve(opened.hash, 'create_funding_account');
    expect(await sign(SPONSOR, opened.payload)).toBe('resolved');
    const activated = sandwich({ steps: ['begin', 'trust', 'end'] });
    world.reserve(activated.hash, 'recipient_activation');
    expect(await sign(SPONSOR, activated.payload)).toBe('resolved');
  });

  it.each<[string, Parameters<typeof sandwich>[0]]>([
    ['an extra operation', { steps: ['begin', 'create', 'trust', 'end', 'payment'] }],
    ['wrong order', { steps: ['begin', 'trust', 'create', 'end'] }],
    ['ChangeTrust to another asset', { asset: { code: 'EURC', issuer: ISSUER } }],
    ['time bounds over 300 s', { validitySeconds: 301 }],
    ['no begin', { steps: ['create', 'trust', 'end'] }],
    ['no end', { steps: ['begin', 'create', 'trust'] }],
    ['a fee over the cap', { feePerOperation: 501 }],
  ])('%s is SIGNER_DENIED', async (_label, options) => {
    const { payload, hash } = sandwich(options);
    world.reserve(hash, 'create_funding_account', 1_000_000n);
    expect(await sign(SPONSOR, payload)).toBe('SIGNER_DENIED');
  });

  it('no reserved ledger row is SIGNER_DENIED', async () => {
    expect(await sign(SPONSOR, sandwich({ validitySeconds: 299 }).payload)).toBe('SIGNER_DENIED');
  });

  it('refuses a sandwich reserved for a fee bump', async () => {
    const { payload, hash } = sandwich({ validitySeconds: 298 });
    world.reserve(hash, 'fee_bump');
    expect(await sign(SPONSOR, payload)).toBe('SIGNER_DENIED');
  });

  it('refuses a plain transaction from the sponsor', async () => {
    const xdr = testInvokeXdr({
      source: world.sponsor,
      calls: [{ contract: TEST_CONTRACT, functionName: 'execute' }],
    });
    expect(await sign(SPONSOR, tx(xdr))).toBe('SIGNER_DENIED');
  });
});

describe('SEP-10 challenges', () => {
  const challenge = (options: Partial<Parameters<typeof testSep10ChallengeXdr>[0]> = {}) =>
    ({
      kind: 'sep10_challenge',
      network: NETWORK,
      xdr: testSep10ChallengeXdr({
        server: SERVER,
        client: world.client,
        webAuthDomain: 'auth.anchor.example',
        timeBounds: { minTime: NOW - 60, maxTime: NOW + 840 },
        ...options,
      }),
    }) as const;

  it('signs a valid challenge', async () => {
    expect(await sign(SEP10, challenge())).toBe('resolved');
  });

  it('a challenge with a payment operation is SIGNER_DENIED', async () => {
    expect(await sign(SEP10, challenge({ withPayment: true }))).toBe('SIGNER_DENIED');
  });

  it.each<[string, Partial<Parameters<typeof testSep10ChallengeXdr>[0]>]>([
    ['another server account', { server: TEST_DESTINATION }],
    ['another home domain', { homeDomain: 'evil.example' }],
    ['another web auth domain', { webAuthDomain: 'anchor.example' }],
    ['a sequence that can be applied', { sequence: 5n }],
    ['an expired window', { timeBounds: { minTime: NOW - 900, maxTime: NOW - 1 } }],
    ['a window not yet open', { timeBounds: { minTime: NOW + 1, maxTime: NOW + 60 } }],
    ['a window over 900 s', { timeBounds: { minTime: NOW - 61, maxTime: NOW + 840 } }],
    ['no upper bound', { timeBounds: { minTime: 0, maxTime: 0 } }],
  ])('refuses %s', async (_label, options) => {
    expect(await sign(SEP10, challenge(options))).toBe('SIGNER_DENIED');
  });

  it('refuses an anchor it has no configuration for, and a network it does not serve', async () => {
    expect(await sign({ ...SEP10, anchorId: 'other.example' }, challenge())).toBe('SIGNER_DENIED');
    const pubnet: SignerRef = { ...SEP10, network: 'stellar:pubnet' };
    expect(await sign(pubnet, { ...challenge(), network: 'stellar:pubnet' })).toBe('SIGNER_DENIED');
    expect(await sign(SEP10, tx(challenge().xdr))).toBe('SIGNER_DENIED');
  });
});

describe('ref kinds the chain service does not serve', () => {
  it('refuses agent, attester and external refs before the policy', async () => {
    const refs: SignerRef[] = [
      { kind: 'managed_agent', network: NETWORK, scope: TENANT, agentId: TENANT.projectId },
      { kind: 'attester', network: NETWORK },
    ];
    for (const ref of refs) {
      expect(await codeOf(world.service.remote.address(ref, OPTS))).toBe('SIGNER_DENIED');
    }
  });
});
