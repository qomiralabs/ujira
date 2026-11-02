// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Executor leases are fenced by their lease id: the store accepts a release
// only from the lease it handed out last, and the adapter always releases
// with the lease it was given and reads the sequence from the chain. These
// run against the in-memory store, which fences the way the database store
// must.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { ExecutorUnfundedError, InvalidInputError } from '../errors.js';
import type { UnixSeconds } from '../types.js';
import { ExecutorSession } from './executor.js';
import { NETWORK, NOW, OPTS, setup } from './test-adapter.js';
import { memoryStore } from './test-ports.js';

describe('executor lease fencing', { timeout: 30_000 }, () => {
  it('refuses a release from a lease that was taken over', async () => {
    const account = Keypair.random().publicKey();
    const store = memoryStore(
      NETWORK,
      [{ address: account, keyId: 'k' }],
      () => NOW as UnixSeconds,
    );
    const first = await store.leaseExecutor(NETWORK, 60);
    const second = await store.leaseExecutor(NETWORK, 60);
    expect(second.leaseId).not.toBe(first.leaseId);
    await expect(store.releaseExecutor(first, { sequenceOrNonce: 5n })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await store.releaseExecutor(second, { sequenceOrNonce: 6n });
    expect(store.releases).toEqual([{ leaseId: second.leaseId, sequenceOrNonce: 6n }]);
    // A lease released once cannot be released again.
    await expect(store.releaseExecutor(second, { sequenceOrNonce: 7n })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(store.leaseExecutor('stellar:pubnet', 60)).rejects.toThrow('no executor');
  });

  it('uses the sequence on chain rather than the one the lease carries', async () => {
    const t = setup();
    const used = await ExecutorSession.run(
      {
        network: NETWORK,
        rpc: t.rpc,
        ports: t.ports,
        wait: { attempts: 1, intervalMs: 0, sleep: () => Promise.resolve() },
        leaseSeconds: 60,
        submitTimeoutMs: 1000,
      },
      OPTS,
      (session) => {
        expect(session.lease.sequenceOrNonce).toBe(0n);
        return Promise.resolve(session.sequence);
      },
    );
    expect(used).toBe(900n);
    expect(t.store.releases).toEqual([
      { leaseId: expect.any(String) as string, sequenceOrNonce: 901n },
    ]);
  });

  it('releases the lease it holds even when the account is missing or the work fails', async () => {
    const t = setup();
    const ctx = {
      network: NETWORK,
      rpc: t.rpc,
      ports: t.ports,
      wait: { attempts: 1, intervalMs: 0, sleep: () => Promise.resolve() },
      leaseSeconds: 60,
      submitTimeoutMs: 1000,
    };
    await expect(
      ExecutorSession.run(ctx, OPTS, () => Promise.reject(new Error('work failed'))),
    ).rejects.toThrow('work failed');
    t.rpc.entries.clear();
    await expect(ExecutorSession.run(ctx, OPTS, () => Promise.resolve(1))).rejects.toBeInstanceOf(
      ExecutorUnfundedError,
    );
    expect(t.store.releases.map((r) => r.sequenceOrNonce)).toEqual([901n, 0n]);
  });
});
