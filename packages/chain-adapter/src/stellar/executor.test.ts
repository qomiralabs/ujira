// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Keypair, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { ExecutorUnfundedError, SubmissionUnknownError } from '../errors.js';
import { FakeAdapterStore } from '../testing/fake-store.js';
import type { ExecutorLease, SubmissionRecord, UnixSeconds } from '../types.js';
import { ExecutorSession, sendAndRecord } from './executor.js';
import type { ExecutorContext } from './executor.js';
import { fateOf, reconcileSubmission, reconcileUnresolved } from './lifecycle.js';
import { NETWORK, NOW, OPTS, addAccount, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { recordingSponsorship } from './test-ports.js';
import { invokeTx, txHash } from './tx.js';

const WAIT = { attempts: 3, intervalMs: 0, sleep: () => Promise.resolve() };

function context(t: TestSetup, over: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    network: NETWORK,
    rpc: t.rpc,
    ports: t.ports,
    wait: WAIT,
    leaseSeconds: 60,
    submitTimeoutMs: 1000,
    lowBalanceAlerted: new Set(),
    ...over,
  };
}

function pool(t: TestSetup, size: number, clock: () => UnixSeconds = () => NOW as UnixSeconds) {
  const accounts = Array.from({ length: size }, (_, i) => {
    const key = Keypair.random();
    addAccount(t.rpc, key.publicKey(), BigInt(1000 + i));
    return {
      address: { network: NETWORK, value: key.publicKey() },
      keyId: `channel-${String(i)}`,
      sequenceOrNonce: 0n,
    };
  });
  return new FakeAdapterStore({ clock, executors: accounts });
}

const record = (over: Partial<SubmissionRecord> = {}): SubmissionRecord => ({
  scope: {
    principalId: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
  } as SubmissionRecord['scope'],
  network: NETWORK,
  txHash: 'aa'.repeat(32),
  op: 'pause',
  mandate: null,
  payoutId: null,
  attempt: null,
  signerAddress: 'G',
  sequenceOrNonce: 1n,
  maxTime: 1000n as UnixSeconds,
  state: 'broadcast',
  landedAtHeight: null,
  errorCode: null,
  specCode: null,
  replacesTxHash: null,
  submittedAtLedger: 500n,
  reservationId: null,
  correlationId: 'c',
  createdAt: 1n as UnixSeconds,
  ...over,
});

function resultXdr(feeCharged: bigint): string {
  return new xdr.TransactionResult({
    feeCharged,
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: xdr.TransactionResultExt.v0(),
  }).toXdr('base64');
}

describe('executor leases', { timeout: 30_000 }, () => {
  it('10 parallel jobs use 10 distinct leases', async () => {
    const t = setup();
    const store = pool(t, 10);
    const ctx = context(t, { ports: { ...t.ports, store } });
    const held: ExecutorLease[] = [];
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobs = Array.from({ length: 10 }, () =>
      ExecutorSession.run(ctx, OPTS, async (session) => {
        held.push(session.lease);
        if (held.length === 10) release();
        await barrier;
      }),
    );
    await Promise.all(jobs);
    expect(new Set(held.map((l) => l.address.value)).size).toBe(10);
    expect(new Set(held.map((l) => l.leaseId)).size).toBe(10);
    // An eleventh job with every account out has nothing to take.
    const none = pool(t, 1);
    const first = await none.leaseExecutor(NETWORK, 60);
    await expect(none.leaseExecutor(NETWORK, 60)).rejects.toThrow();
    await none.releaseExecutor(first, { sequenceOrNonce: 1n });
  });

  it('release with a stale leaseId is refused', async () => {
    const t = setup();
    let now = NOW;
    const store = pool(t, 1, () => now as UnixSeconds);
    const ctx = context(t, { ports: { ...t.ports, store } });
    // The job outlives its lease and another job takes the account.
    const result = await ExecutorSession.run(ctx, OPTS, async (session) => {
      now += 61n;
      const takeover = await store.leaseExecutor(NETWORK, 60);
      expect(takeover.leaseId).not.toBe(session.lease.leaseId);
      await expect(
        store.releaseExecutor(session.lease, { sequenceOrNonce: 999_999n }),
      ).rejects.toThrow();
      session.sequence = 999_999n;
      return 'done';
    });
    // The stale release was refused and changes nothing, and the job's own
    // outcome still stands: losing the lease says nothing about what it sent.
    expect(result).toBe('done');
    const next = await store.leaseExecutor(NETWORK, 60).catch(() => null);
    expect(next).toBeNull();
    now += 61n;
    const after = await store.leaseExecutor(NETWORK, 60);
    expect(after.sequenceOrNonce).toBe(0n);
  });

  it('reads the sequence from the chain, whatever the lease carries', async () => {
    const t = setup();
    const key = Keypair.random();
    addAccount(t.rpc, key.publicKey(), 7777n);
    const store = new FakeAdapterStore({
      clock: () => NOW as UnixSeconds,
      executors: [
        { address: { network: NETWORK, value: key.publicKey() }, keyId: 'k', sequenceOrNonce: 5n },
      ],
    });
    const ctx = context(t, { ports: { ...t.ports, store } });
    const seen = await ExecutorSession.run(ctx, OPTS, (s) =>
      Promise.resolve([s.lease.sequenceOrNonce, s.sequence]),
    );
    expect(seen).toEqual([5n, 7777n]);
  });

  it('watches the channel balance with the same alert as the sponsor, once per drop', async () => {
    const t = setup();
    const alerts: { account: string; balance: { amount: bigint } }[] = [];
    const ports = {
      ...t.ports,
      alerts: { ...t.ports.alerts, lowBalance: (e: (typeof alerts)[0]) => alerts.push(e) },
    };
    const ctx = context(t, { ports: ports });
    // 10 XLM: below the 50 XLM default, above the 5 XLM minimum.
    await ExecutorSession.run(ctx, OPTS, () => Promise.resolve());
    await ExecutorSession.run(ctx, OPTS, () => Promise.resolve());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ account: 'executor', balance: { amount: 100_000_000n } });
    addAccount(t.rpc, t.channel.publicKey(), 900n, 500_000_000n);
    await ExecutorSession.run(ctx, OPTS, () => Promise.resolve());
    addAccount(t.rpc, t.channel.publicKey(), 900n, 100_000_000n);
    await ExecutorSession.run(ctx, OPTS, () => Promise.resolve());
    expect(alerts).toHaveLength(2);
  });

  it('refuses a channel below its minimum and still gives the lease back', async () => {
    const t = setup();
    addAccount(t.rpc, t.channel.publicKey(), 900n, 50_000_000n - 1n);
    await expect(
      ExecutorSession.run(context(t), OPTS, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(ExecutorUnfundedError);
    expect(t.store.releases).toHaveLength(1);
  });
});

describe('sending', { timeout: 30_000 }, () => {
  function envelope(t: TestSetup): { tx: Transaction; hash: string } {
    const tx = invokeTx(
      { contract: t.mandate.address.value, fn: 'pause', args: [] },
      { network: NETWORK, source: t.channel.publicKey(), sequence: 1n, maxTime: NOW + 100n },
    );
    return { tx, hash: txHash(tx) };
  }

  async function recorded(t: TestSetup, hash: string): Promise<void> {
    await t.store.recordSubmission(record({ scope: t.scope, txHash: hash, state: 'built' }));
  }

  it('TRY_AGAIN_LATER resubmits the identical envelope', async () => {
    const t = setup();
    const { tx, hash } = envelope(t);
    await recorded(t, hash);
    const answers = ['TRY_AGAIN_LATER', 'TRY_AGAIN_LATER', 'PENDING'] as const;
    t.rpc.sendResult = () => ({ status: answers[t.rpc.sent.length - 1] ?? 'PENDING', hash });
    await sendAndRecord(context(t), t.scope, hash, tx.toXdr(), NOW + 100n, OPTS);
    expect(t.rpc.sent).toHaveLength(3);
    expect(new Set(t.rpc.sent).size).toBe(1);
    expect(txHash(TransactionBuilder.fromXdr(t.rpc.sent[2] ?? '', tx.networkPassphrase))).toBe(
      hash,
    );
    expect(t.store.submissions.get(`${NETWORK}:${hash}`)?.state).toBe('broadcast');
  });

  it('stops resubmitting at maxTime and leaves the outcome for reconciliation', async () => {
    const t = setup();
    const { tx, hash } = envelope(t);
    await recorded(t, hash);
    t.rpc.sendResult = () => ({ status: 'TRY_AGAIN_LATER', hash });
    t.clock.now = NOW + 100n;
    await expect(
      sendAndRecord(context(t), t.scope, hash, tx.toXdr(), NOW + 100n, OPTS),
    ).rejects.toBeInstanceOf(SubmissionUnknownError);
    expect(t.rpc.sent).toHaveLength(1);
    // It may have been accepted by an earlier try, so it stays open.
    expect(t.store.submissions.get(`${NETWORK}:${hash}`)?.state).toBe('broadcast');
  });

  it('stops resubmitting after its attempts, within maxTime', async () => {
    const t = setup();
    const { tx, hash } = envelope(t);
    await recorded(t, hash);
    t.rpc.sendResult = () => ({ status: 'TRY_AGAIN_LATER', hash });
    await expect(
      sendAndRecord(context(t), t.scope, hash, tx.toXdr(), NOW + 100n, OPTS),
    ).rejects.toBeInstanceOf(SubmissionUnknownError);
    expect(t.rpc.sent).toHaveLength(3);
  });
});

describe('what became of a transaction', { timeout: 30_000 }, () => {
  const past = { status: 'NOT_FOUND', latestLedger: 900, latestLedgerCloseTime: 1001n } as const;

  it('rebuild after maxTime with NOT_FOUND', () => {
    expect(fateOf({ ...past, oldestLedger: 500 }, record())).toEqual({ kind: 'dead' });
    expect(fateOf({ ...past, oldestLedger: 499 }, record())).toEqual({ kind: 'dead' });
  });

  it('unknown when oldestLedger is above submission', () => {
    expect(fateOf({ ...past, oldestLedger: 501 }, record())).toEqual({ kind: 'unknown' });
  });

  it('never calls a transaction dead while its window is open', () => {
    expect(
      fateOf({ status: 'NOT_FOUND', latestLedgerCloseTime: 1000n, oldestLedger: 1 }, record()),
    ).toEqual({ kind: 'pending' });
  });

  it('never calls one dead without everything the proof needs', () => {
    const unknown = { kind: 'unknown' };
    expect(fateOf({ status: 'NOT_FOUND', oldestLedger: 1 }, record())).toEqual(unknown);
    expect(fateOf({ ...past, oldestLedger: 1 }, record({ maxTime: null }))).toEqual(unknown);
    expect(fateOf({ ...past, oldestLedger: 1 }, record({ submittedAtLedger: null }))).toEqual(
      unknown,
    );
    expect(fateOf(past, record())).toEqual(unknown);
  });

  it('reads an included transaction and its fee', () => {
    expect(fateOf({ status: 'SUCCESS', ledger: 7, resultXdr: resultXdr(123n) }, record())).toEqual({
      kind: 'landed',
      ledger: 7n,
      feeCharged: 123n,
    });
    expect(fateOf({ status: 'FAILED', ledger: 8 }, record())).toEqual({
      kind: 'failed',
      ledger: 8n,
      feeCharged: null,
    });
    expect(fateOf({ status: 'SUCCESS', resultXdr: 'garbage' }, record())).toEqual({
      kind: 'landed',
      ledger: 0n,
      feeCharged: null,
    });
  });
});

describe('reconciliation', { timeout: 30_000 }, () => {
  function world() {
    const t = setup();
    const sponsorship = recordingSponsorship();
    const store = new FakeAdapterStore({ clock: () => t.clock.now as UnixSeconds });
    const ctx = { network: NETWORK, rpc: t.rpc, ports: { ...t.ports, store, sponsorship } };
    return { t, store, sponsorship, ctx };
  }

  async function put(store: FakeAdapterStore, over: Partial<SubmissionRecord>) {
    const r = record({ state: 'built', ...over });
    await store.recordSubmission(r);
    return r;
  }

  it('books the network fee of an executor transaction when it lands', async () => {
    const { t, store, sponsorship, ctx } = world();
    const r = await put(store, {});
    t.rpc.txs.set(r.txHash, { status: 'SUCCESS', ledger: 77, resultXdr: resultXdr(321n) });
    expect(await reconcileSubmission(ctx, r, OPTS)).toEqual({
      txHash: r.txHash,
      state: 'landed',
      mayRebuild: false,
    });
    expect(store.submissions[0]).toMatchObject({ state: 'landed', landedAtHeight: 77n });
    expect(sponsorship.calls.map((c) => c.kind)).toEqual(['book']);
  });

  it('settles a sponsored transaction against its reservation, landed or failed', async () => {
    const { t, store, sponsorship, ctx } = world();
    const r = await put(store, { reservationId: 'reservation' });
    t.rpc.txs.set(r.txHash, { status: 'FAILED', ledger: 9, resultXdr: resultXdr(50n) });
    expect((await reconcileSubmission(ctx, r, OPTS)).state).toBe('failed');
    expect(store.submissions[0]).toMatchObject({ errorCode: 'SUBMISSION_REJECTED' });
    expect(sponsorship.calls).toEqual([{ kind: 'settle', id: 'reservation' }]);
  });

  it('expires a dead transaction, gives its reservation back and allows a rebuild', async () => {
    const { t, store, sponsorship, ctx } = world();
    const r = await put(store, { reservationId: 'reservation' });
    t.rpc.txs.set(r.txHash, { status: 'NOT_FOUND', latestLedgerCloseTime: 2000n, oldestLedger: 1 });
    expect(await reconcileSubmission(ctx, r, OPTS)).toEqual({
      txHash: r.txHash,
      state: 'expired',
      mayRebuild: true,
    });
    expect(sponsorship.calls).toEqual([{ kind: 'release', id: 'reservation' }]);
  });

  it('keeps an unprovable transaction open and never allows a rebuild', async () => {
    const { t, store, sponsorship, ctx } = world();
    const r = await put(store, { reservationId: 'reservation' });
    t.rpc.txs.set(r.txHash, {
      status: 'NOT_FOUND',
      latestLedgerCloseTime: 2000n,
      oldestLedger: 501,
    });
    const result = await reconcileSubmission(ctx, r, OPTS);
    expect(result).toMatchObject({ state: 'unknown', mayRebuild: false });
    // Asked again it stays there, with its reservation still held.
    const again = await reconcileSubmission(ctx, { ...r, state: 'unknown' }, OPTS);
    expect(again).toMatchObject({ state: 'unknown', mayRebuild: false });
    expect(sponsorship.calls).toEqual([]);
  });

  it('leaves a transaction alone while its window is open', async () => {
    const { t, store, ctx } = world();
    const r = await put(store, {});
    t.rpc.txs.set(r.txHash, { status: 'NOT_FOUND', latestLedgerCloseTime: 10n });
    expect(await reconcileSubmission(ctx, r, OPTS)).toMatchObject({
      state: 'built',
      mayRebuild: false,
    });
    expect(store.submissions[0]?.state).toBe('built');
  });

  it('sweeps what is open, alerts on what is stuck, and survives a read that fails', async () => {
    const { t, store, ctx } = world();
    const stuck: { txHash: string; ageSeconds: number }[] = [];
    const ports = {
      ...ctx.ports,
      alerts: { ...ctx.ports.alerts, stuck: (e: (typeof stuck)[0]) => stuck.push(e) },
    };
    const old = 'bb'.repeat(32);
    const broken = 'cc'.repeat(32);
    const landed = 'dd'.repeat(32);
    const at = (t.clock.now - 1000n) as UnixSeconds;
    await put(store, { txHash: old, createdAt: at, maxTime: (NOW + 1000n) as UnixSeconds });
    await put(store, { txHash: broken, createdAt: at });
    await put(store, { txHash: landed, createdAt: at });
    await store.updateSubmission(record().scope, NETWORK, old, { state: 'broadcast' });
    await store.updateSubmission(record().scope, NETWORK, broken, { state: 'broadcast' });
    await store.updateSubmission(record().scope, NETWORK, landed, { state: 'broadcast' });
    t.rpc.txs.set(old, { status: 'NOT_FOUND', latestLedgerCloseTime: NOW });
    t.rpc.txs.set(landed, { status: 'SUCCESS', ledger: 5 });
    const read = t.rpc.getTransaction.bind(t.rpc);
    t.rpc.getTransaction = (hash) =>
      hash === broken ? Promise.reject(new Error('down')) : read(hash);
    const results = await reconcileUnresolved(
      { ...ctx, ports: ports },
      { olderThanSeconds: 60, limit: 10, stuckAfterSeconds: 300 },
      OPTS,
    );
    expect(Object.fromEntries(results.map((r) => [r.txHash, r.state]))).toEqual({
      [old]: 'broadcast',
      [broken]: 'broadcast',
      [landed]: 'landed',
    });
    expect(stuck.map((e) => e.txHash)).toEqual([old]);
    expect(stuck[0]?.ageSeconds).toBe(1000);
  });
});
