// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the agent signer's policy (service/agent-policy.ts), run
 * through the whole service: RemoteSigner, the HTTP handler, the policy and
 * the local backend.
 *
 * An agent key signs one call to request_payout or request_payouts, as a
 * transaction or an authorization entry with nothing nested, on an indexed
 * mandate of the ref's own tenant whose recipient mode is allowlist or both,
 * with the active key of that tenant and agent, whose tags equal the tenant,
 * under the per principal limit. Everything else is SIGNER_DENIED, and a
 * refused request does not use up the limit.
 */

import type { NetworkId, SignPayload, SignerRef, Uuid } from '@ujira/chain-adapter';
import {
  TEST_CONTRACT,
  contractAddress,
  testAuthEntryXdr,
  testFeeBumpXdr,
  testInvokeXdr,
} from '@ujira/chain-adapter/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { OPTS, TEST_SEED, codeOf, harness } from '../testing/service.js';
import type { Harness } from '../testing/service.js';
import {
  agentPolicy,
  memoryManagedSignerStore,
  memoryMandateIndex,
  memoryRateLimiter,
} from './index.js';
import type { MemoryMandate, RecipientMode } from './index.js';

const NETWORK: NetworkId = 'stellar:testnet';
const NOW = 1_900_000_000;
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const OTHER_TENANT = { ...TENANT, projectId: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as Uuid };
const AGENT = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' as Uuid;
const AGENT_WITH_NO_ROW = '8b7c6d5e-4f3a-4b2c-8d9e-0f1a2b3c4d5e' as Uuid;
const ATTESTED_MANDATE = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const OTHER_TENANT_MANDATE = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';

const REF: Extract<SignerRef, { kind: 'managed_agent' }> = {
  kind: 'managed_agent',
  network: NETWORK,
  scope: TENANT,
  agentId: AGENT,
};

interface World {
  readonly service: Harness;
  readonly account: string;
  readonly otherAccount: string;
}

function mandate(contract: string, recipientMode: RecipientMode, tenant = TENANT): MemoryMandate {
  return { network: NETWORK, contract, executors: [], tenant, recipientMode };
}

let world: World;

beforeAll(async () => {
  const keys = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
  const account = (await keys.address(REF, OPTS)).value;
  const otherRef: SignerRef = { ...REF, scope: OTHER_TENANT };
  const otherAccount = (await keys.address(otherRef, OPTS)).value;
  world = {
    account,
    otherAccount,
    service: harness({
      nowSeconds: NOW,
      policy: agentPolicy({
        signers: memoryManagedSignerStore([
          {
            network: NETWORK,
            scope: TENANT,
            agentId: AGENT,
            address: account,
            keyRef: 'agent-key',
            keyTags: TENANT,
          },
          // The row names this tenant, but the key manager's tags say the
          // key belongs to another one.
          {
            network: NETWORK,
            scope: OTHER_TENANT,
            agentId: AGENT,
            address: otherAccount,
            keyRef: 'agent-key-2',
            keyTags: TENANT,
          },
        ]),
        mandates: memoryMandateIndex([
          mandate(TEST_CONTRACT, 'allowlist'),
          mandate(ATTESTED_MANDATE, 'attested'),
          mandate(OTHER_TENANT_MANDATE, 'both', OTHER_TENANT),
        ]),
        rateLimiter: memoryRateLimiter({ limit: 1_000, windowSeconds: 60n }),
      }),
    }),
  };
});

const sign = (payload: SignPayload, ref: SignerRef = REF) =>
  codeOf(world.service.remote.sign(ref, payload, OPTS));

const call = (functionName: string, contract = TEST_CONTRACT, source?: string): SignPayload => ({
  kind: 'stellar_tx',
  network: NETWORK,
  xdr: testInvokeXdr({
    source: source ?? world.account,
    calls: [{ contract, functionName }],
  }),
});

const entry = (functionName: string, nested = false): SignPayload => ({
  kind: 'stellar_auth_entry',
  network: NETWORK,
  entryXdr: testAuthEntryXdr({ address: world.account, functionName, nested }),
  expirationLedger: 5_000,
});

describe('the agent policy', () => {
  it('signs request_payout and its batch, as a transaction or an entry', async () => {
    expect(await sign(call('request_payout'))).toBe('resolved');
    expect(await sign(call('request_payouts'))).toBe('resolved');
    expect(await sign(entry('request_payout'))).toBe('resolved');
  });

  it('an approve call signed as agent is SIGNER_DENIED', async () => {
    expect(await sign(call('approve'))).toBe('SIGNER_DENIED');
    expect(await sign(entry('approve'))).toBe('SIGNER_DENIED');
  });

  it('refuses a nested call, two calls and a payload kind agents never sign', async () => {
    expect(await sign(entry('request_payout', true))).toBe('SIGNER_DENIED');
    const two: SignPayload = {
      kind: 'stellar_tx',
      network: NETWORK,
      xdr: testInvokeXdr({
        source: world.account,
        calls: [
          { contract: TEST_CONTRACT, functionName: 'request_payout' },
          { contract: TEST_CONTRACT, functionName: 'request_payout' },
        ],
      }),
    };
    expect(await sign(two)).toBe('SIGNER_DENIED');
    const bump: SignPayload = {
      kind: 'stellar_fee_bump',
      network: NETWORK,
      xdr: testFeeBumpXdr({ feeSource: world.account }),
    };
    expect(await sign(bump)).toBe('SIGNER_DENIED');
    expect(await sign({ kind: 'stellar_tx', network: NETWORK, xdr: 'AAAA' })).toBe('SIGNER_DENIED');
  });

  it('key tags not matching the request tenant are SIGNER_DENIED', async () => {
    const ref: SignerRef = { ...REF, scope: OTHER_TENANT };
    const payload = call('request_payout', OTHER_TENANT_MANDATE, world.otherAccount);
    expect(await sign(payload, ref)).toBe('SIGNER_DENIED');
  });

  it('refuses a mandate of another tenant, and one not indexed', async () => {
    expect(await sign(call('request_payout', OTHER_TENANT_MANDATE))).toBe('SIGNER_DENIED');
    const unindexed = contractAddress(new Uint8Array(32).fill(9));
    expect(await sign(call('request_payout', unindexed))).toBe('SIGNER_DENIED');
  });

  it('refuses an agent with no active key, and a payload for another account', async () => {
    const noKey: SignerRef = { ...REF, agentId: AGENT_WITH_NO_ROW };
    expect(await sign(call('request_payout'), noKey)).toBe('SIGNER_DENIED');
    expect(await sign(call('request_payout', TEST_CONTRACT, world.otherAccount))).toBe(
      'SIGNER_DENIED',
    );
  });

  it('ATTESTED-only mandate is SIGNER_DENIED', async () => {
    expect(await sign(call('request_payout', ATTESTED_MANDATE))).toBe('SIGNER_DENIED');
  });

  it('allows a mandate in BOTH mode', async () => {
    const both = harness({
      nowSeconds: NOW,
      policy: agentPolicy({
        signers: memoryManagedSignerStore([
          {
            network: NETWORK,
            scope: TENANT,
            agentId: AGENT,
            address: world.account,
            keyRef: 'agent-key',
            keyTags: TENANT,
          },
        ]),
        mandates: memoryMandateIndex([mandate(TEST_CONTRACT, 'both')]),
        rateLimiter: memoryRateLimiter({ limit: 10, windowSeconds: 60n }),
      }),
    });
    expect(await codeOf(both.remote.sign(REF, call('request_payout'), OPTS))).toBe('resolved');
  });

  it('requests over the per-principal limit are SIGNER_DENIED', async () => {
    let now = NOW;
    const limiter = memoryRateLimiter({ limit: 2, windowSeconds: 60n });
    const limited = harness({
      policy: agentPolicy({
        signers: memoryManagedSignerStore([
          {
            network: NETWORK,
            scope: TENANT,
            agentId: AGENT,
            address: world.account,
            keyRef: 'agent-key',
            keyTags: TENANT,
          },
        ]),
        mandates: memoryMandateIndex([mandate(TEST_CONTRACT, 'allowlist')]),
        rateLimiter: {
          take: (principalId, _at, opts) => limiter.take(principalId, BigInt(now), opts),
        },
      }),
    });
    const ask = () => codeOf(limited.remote.sign(REF, call('request_payout'), OPTS));
    // A refused request does not count.
    expect(await codeOf(limited.remote.sign(REF, call('approve'), OPTS))).toBe('SIGNER_DENIED');
    expect(await ask()).toBe('resolved');
    expect(await ask()).toBe('resolved');
    expect(await ask()).toBe('SIGNER_DENIED');
    // The next window starts again.
    now += 60;
    expect(await ask()).toBe('resolved');
  });

  it('serves only agent refs', async () => {
    const executor: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };
    expect(await codeOf(world.service.remote.address(executor, OPTS))).toBe('SIGNER_DENIED');
    expect(await sign(call('request_payout'), executor)).toBe('SIGNER_DENIED');
  });
});
