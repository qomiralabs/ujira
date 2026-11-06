// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What an executor may cancel. After a payout lapses the mandate lets anyone cancel it, so
// an executor gains nothing by being allowed to send that call. The one way it could gain
// is by also being the mandate's principal or an agent, since the contract would then take
// its cancel of a live payout. That is what this policy has to refuse, and it refuses when
// the index cannot say.

import type { NetworkId, SignPayload, SignerRef, Uuid } from '@ujira/chain-adapter';
import {
  TEST_CONTRACT,
  TEST_DESTINATION,
  TEST_INNER_SOURCE,
  testAuthEntryXdr,
  testInvokeXdr,
} from '@ujira/chain-adapter/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { OPTS, TEST_SEED, codeOf, harness } from '../testing/service.js';
import { TEST_SETTLEMENT } from '../testing/unpayable.js';
import { AGENT_FUNCTIONS } from './agent-policy.js';
import {
  EXECUTOR_FUNCTIONS,
  chainPolicy,
  memoryMandateIndex,
  memorySponsorshipLedger,
} from './index.js';
import type { MemoryMandate } from './index.js';

const NETWORK: NetworkId = 'stellar:testnet';
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const EXECUTOR: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };
const AGENT: SignerRef = {
  kind: 'managed_agent',
  network: NETWORK,
  scope: TENANT,
  agentId: '7a1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
};

let executor: string;

beforeAll(async () => {
  executor = (await new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' }).address(EXECUTOR, OPTS))
    .value;
});

type Mandate = Partial<Pick<MemoryMandate, 'executors' | 'principal' | 'agents'>>;

// A service with one mandate on the index, as the caller describes it.
function signing(mandate: Mandate | null, ref: SignerRef = EXECUTOR) {
  const service = harness({
    nowSeconds: 1_900_000_000,
    policy: chainPolicy({
      mandates: memoryMandateIndex(
        mandate === null
          ? []
          : [
              {
                network: NETWORK,
                contract: TEST_CONTRACT,
                executors: [executor],
                tenant: TENANT,
                recipientMode: 'allowlist',
                ...TEST_SETTLEMENT,
                ...mandate,
              },
            ],
      ),
      sponsorships: memorySponsorshipLedger([]),
      networks: {
        [NETWORK]: {
          executorMaxFeeStroops: 1_000_000n,
          sponsorMaxFeeStroops: 2_000n,
          payoutAsset: { code: 'USDC', issuer: TEST_INNER_SOURCE },
          sep10: {},
        },
      },
    }),
  });
  return async (payload: SignPayload) => codeOf(service.remote.sign(ref, payload, OPTS));
}

const invoke = (functionName: string): SignPayload => ({
  kind: 'stellar_tx',
  network: NETWORK,
  xdr: testInvokeXdr({
    source: executor,
    calls: [{ contract: TEST_CONTRACT, functionName }],
  }),
});

const entry = (functionName: string, nested = false): SignPayload => ({
  kind: 'stellar_auth_entry',
  network: NETWORK,
  entryXdr: testAuthEntryXdr({ address: executor, functionName, nested }),
  expirationLedger: 5_000,
});

const CLEAN: Mandate = { principal: TEST_DESTINATION, agents: [TEST_INNER_SOURCE] };

describe('an executor cancelling', () => {
  it.each(['cancel', 'cancel_batch'])('signs %s on a mandate it serves', async (fn) => {
    const sign = signing(CLEAN);
    expect(await sign(invoke(fn))).toBe('resolved');
    expect(await sign(entry(fn))).toBe('resolved');
  });

  it.each(['cancel', 'cancel_batch'])('refuses %s with anything nested', async (fn) => {
    expect(await signing(CLEAN)(entry(fn, true))).toBe('SIGNER_DENIED');
  });

  it.each(['cancel', 'cancel_batch'])(
    'refuses %s on a mandate the index does not know',
    async (fn) => {
      expect(await signing(null)(invoke(fn))).toBe('SIGNER_DENIED');
    },
  );

  it.each(['cancel', 'cancel_batch'])('refuses %s without the executor role', async (fn) => {
    expect(await signing({ ...CLEAN, executors: [TEST_DESTINATION] })(invoke(fn))).toBe(
      'SIGNER_DENIED',
    );
  });

  describe('as an address the contract would take a live cancel from', () => {
    it.each(['cancel', 'cancel_batch'])('refuses %s when it is also the principal', async (fn) => {
      const sign = signing({ ...CLEAN, principal: executor });
      expect(await sign(invoke(fn))).toBe('SIGNER_DENIED');
      expect(await sign(entry(fn))).toBe('SIGNER_DENIED');
    });

    it.each(['cancel', 'cancel_batch'])('refuses %s when it is also an agent', async (fn) => {
      const sign = signing({ ...CLEAN, agents: [TEST_INNER_SOURCE, executor] });
      expect(await sign(invoke(fn))).toBe('SIGNER_DENIED');
      expect(await sign(entry(fn))).toBe('SIGNER_DENIED');
    });

    it('still lets it execute there, which the role alone decides', async () => {
      const sign = signing({ ...CLEAN, principal: executor });
      expect(await sign(invoke('execute'))).toBe('resolved');
    });

    it('refuses when the index cannot say who holds those roles', async () => {
      expect(await signing({})(invoke('cancel'))).toBe('SIGNER_DENIED');
      expect(await signing({ principal: TEST_DESTINATION })(invoke('cancel'))).toBe(
        'SIGNER_DENIED',
      );
      expect(await signing({ agents: [] })(invoke('cancel'))).toBe('SIGNER_DENIED');
    });
  });

  it('gets nothing else from this', async () => {
    const sign = signing(CLEAN);
    for (const fn of [
      'approve',
      'reject',
      'revoke',
      'pause',
      'withdraw',
      'sweep',
      'request_payout',
    ]) {
      expect(await sign(invoke(fn))).toBe('SIGNER_DENIED');
    }
  });
});

describe('the agent key', () => {
  it('still only asks for a payout, and never cancels', async () => {
    expect([...AGENT_FUNCTIONS].sort()).toEqual(['request_payout', 'request_payouts']);
    expect(await signing(CLEAN, AGENT)(invoke('cancel'))).toBe('SIGNER_DENIED');
  });

  it('what an executor runs stays execute alone, with the cancels on a list of their own', () => {
    expect([...EXECUTOR_FUNCTIONS].sort()).toEqual(['execute', 'execute_batch']);
  });
});
