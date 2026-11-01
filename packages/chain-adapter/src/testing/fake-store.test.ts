// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The in-memory store passes the store contract, and the contract is shown
// to have teeth: with any one rule switched off, some check fails, and only
// checks that rely on that rule do.

import { describe, expect, it } from 'vitest';

import type { NetworkId } from '../networks.js';
import type { TenantScope, UnixSeconds, Uuid } from '../types.js';

import {
  FAKE_GENESIS,
  FakeAdapterStore,
  STORE_RULES,
  accountFromSeed,
  describeAdapterStore,
  isLiveSubmission,
  runAdapterStoreChecks,
  sha256,
} from './index.js';
import type { StoreHarness, StoreRule } from './index.js';

const NETWORK: NetworkId = 'stellar:testnet';
const scope: TenantScope = {
  principalId: '10000000-0000-4000-8000-000000000001' as Uuid,
  projectId: '10000000-0000-4000-8000-000000000002' as Uuid,
};
const otherScope: TenantScope = {
  principalId: '10000000-0000-4000-8000-000000000003' as Uuid,
  projectId: '10000000-0000-4000-8000-000000000004' as Uuid,
};

function fakeStore(unsafeDisable: readonly StoreRule[] = []): () => StoreHarness & {
  readonly fake: FakeAdapterStore;
} {
  return () => {
    let now = FAKE_GENESIS;
    const executors = [1, 2].map((i) => ({
      address: {
        network: NETWORK,
        value: accountFromSeed(sha256(Uint8Array.from([i]))),
      },
      keyId: `executor-${String(i)}`,
      sequenceOrNonce: 1n,
    }));
    const fake = new FakeAdapterStore({
      clock: () => now as UnixSeconds,
      executors,
      unsafeDisable,
    });
    return {
      fake,
      store: fake,
      network: NETWORK,
      otherNetwork: 'stellar:pubnet',
      scope,
      otherScope,
      executors: executors.length,
      now: () => now as UnixSeconds,
      advance: (seconds) => {
        now += seconds;
        return Promise.resolve();
      },
    };
  };
}

describeAdapterStore('FakeAdapterStore', fakeStore());

describe('the store contract catches a store that breaks a rule', () => {
  it('passes every check with every rule enforced', async () => {
    const results = await runAdapterStoreChecks(fakeStore());
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });

  it.each(STORE_RULES.map((rule) => [rule]))('fails a check when %s is off', async (rule) => {
    const results = await runAdapterStoreChecks(fakeStore([rule]));
    const failed = results.filter((r) => !r.passed);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.filter((r) => !r.rules.includes(rule))).toEqual([]);
  });

  it('fails a store that allows a backward state move or accepts a stale lease id', async () => {
    const failedWith = async (rule: StoreRule) =>
      (await runAdapterStoreChecks(fakeStore([rule]))).filter((r) => !r.passed).map((r) => r.name);
    expect(await failedWith('forward_only')).toEqual([
      'refuses every backward or sideways move and keeps the state',
    ]);
    expect(await failedWith('lease_fencing')).toEqual([
      'refuses a release with a lease id that was taken over',
    ]);
  });
});

describe('the fake store', () => {
  it('refuses a release for an unknown account or a sequence that goes back', async () => {
    const h = fakeStore()();
    const lease = await h.store.leaseExecutor(NETWORK, 30);
    const unknown = {
      ...lease,
      address: { ...lease.address, value: accountFromSeed(sha256(Uint8Array.from([9]))) },
    };
    await expect(h.store.releaseExecutor(unknown, { sequenceOrNonce: 5n })).rejects.toMatchObject({
      issues: ['lease (not_found)'],
    });
    await expect(h.store.releaseExecutor(lease, { sequenceOrNonce: 0n })).rejects.toMatchObject({
      issues: ['next.sequenceOrNonce (backward)'],
    });
    await expect(h.store.leaseExecutor('stellar:pubnet', 30)).rejects.toMatchObject({
      issues: ['executor (none_free)'],
    });
    expect(isLiveSubmission('unknown')).toBe(true);
    expect(isLiveSubmission('replaced')).toBe(false);
    expect(new FakeAdapterStore({ clock: () => FAKE_GENESIS as UnixSeconds }).submissions).toEqual(
      [],
    );
  });

  it('reads the most recently updated live delivery across providers', async () => {
    const h = fakeStore()();
    const base = {
      scope,
      legKey: `0x${'ab'.repeat(32)}00` as never,
      network: NETWORK,
      rail: 'stellar.sep31' as const,
      providerRef: 'r',
      destination: { address: { network: NETWORK, value: 'x' }, tag: null },
      quoteId: null,
      state: 'in_transit' as const,
      rawStatus: null,
      live: true,
      expiresAt: null,
    };
    await h.store.upsertDelivery({ ...base, provider: 'a', updatedAt: 5n as UnixSeconds });
    await h.store.upsertDelivery({ ...base, provider: 'b', updatedAt: 9n as UnixSeconds });
    await h.store.upsertDelivery({ ...base, provider: 'c', updatedAt: 7n as UnixSeconds });
    expect((await h.store.liveDelivery(scope, base.legKey))?.provider).toBe('b');
  });
});
