// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The keep-alive job over the real RPC client shape and leased channel
// accounts, on the offline RPC the adapter's own tests use: what it reads,
// what it sends and who pays.

import { TransactionBuilder } from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { MemoryTtlStepStore, RecordingTtlMetrics } from '../testing/ttl.js';

import type { ExecutorContext } from './executor.js';
import { NETWORK, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { FIXTURE_USDC } from './test-rpc.js';
import { parseTtlConfig, runTtlKeepAlive } from './ttl-job.js';
import type { TtlPorts } from './ttl-job.js';
import { keepAliveKeys } from './ttl-keys.js';
import type { KeepAliveTarget } from './ttl-keys.js';
import { ttlReaderFromRpc, ttlSubmitterFromExecutor } from './ttl-wire.js';
import { PASSPHRASES } from './tx.js';

const CONFIG = parseTtlConfig({
  thresholdLedgers: 100_000,
  extendToLedgers: 500_000,
  windowLedgers: 17_280,
  maxKeysPerTransaction: 10,
  rpcTimeoutMs: 5_000,
  submitTimeoutMs: 5_000,
});

function world(t: TestSetup) {
  const target: KeepAliveTarget = {
    mandate: t.mandate.address.value,
    asset: FIXTURE_USDC,
    wasmHash: '03'.repeat(32),
    allowed: [],
    daily: [],
  };
  const keys = keepAliveKeys(target);
  const key = (kind: string): string => keys.find((k) => k.kind === kind)?.xdr ?? 'missing';
  const latest = t.rpc.latest.sequence;
  const put = (id: string, liveUntilLedgerSeq?: number): void => {
    t.rpc.entries.set(id, {
      key: id,
      xdr: 'unused',
      lastModifiedLedgerSeq: 1,
      ...(liveUntilLedgerSeq === undefined ? {} : { liveUntilLedgerSeq }),
    });
  };
  for (const k of keys) put(k.xdr, latest + 400_000);
  const ctx: ExecutorContext = {
    network: NETWORK,
    rpc: t.rpc,
    ports: t.ports,
    wait: { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() },
    leaseSeconds: 60,
    submitTimeoutMs: 5_000,
    lowBalanceAlerted: new Set(),
  };
  const metrics = new RecordingTtlMetrics();
  const ports: TtlPorts = {
    reader: ttlReaderFromRpc(t.rpc, 'ttl-test'),
    submitter: ttlSubmitterFromExecutor(ctx, 'ttl-test'),
    store: new MemoryTtlStepStore(),
    metrics,
  };
  const job = { scope: t.scope, network: NETWORK, target };
  return { key, put, latest, ports, job, metrics };
}

function sent(t: TestSetup) {
  return t.rpc.sent.map((envelope) => {
    const tx = TransactionBuilder.fromXdr(envelope, PASSPHRASES[NETWORK]) as Transaction;
    const env = tx.toEnvelope();
    const data =
      env.type === 'envelopeTypeTx' && env.v1.tx.ext.type === 'sorobanData'
        ? env.v1.tx.ext.sorobanData
        : null;
    const footprint = data?.resources.footprint;
    const op = tx.operations[0];
    return {
      source: tx.source,
      memo: tx.memo.type,
      type: op?.type,
      extendTo: op?.type === 'extendFootprintTtl' ? op.extendTo : undefined,
      readOnly: (footprint?.readOnly ?? []).map((k) => k.toXdr('base64')),
      readWrite: (footprint?.readWrite ?? []).map((k) => k.toXdr('base64')),
    };
  });
}

describe('the keep-alive job on the Stellar adapter', { timeout: 30_000 }, () => {
  it('extends only what is lapsing, from a channel account, with no memo', async () => {
    const t = setup();
    const { key, put, latest, ports, job } = world(t);
    put(key('balance'), latest + 10);
    const result = await runTtlKeepAlive(job, CONFIG, ports);
    expect(result).toMatchObject({ belowThreshold: 1, extended: 1, archived: 0 });
    expect(sent(t)).toEqual([
      {
        source: t.channel.publicKey(),
        memo: 'none',
        type: 'extendFootprintTtl',
        extendTo: 500_000,
        readOnly: [key('balance')],
        readWrite: [],
      },
    ]);
    const records = [...t.store.submissions.values()];
    expect(records.map((r) => [r.op, r.state, r.mandate, r.scope])).toEqual([
      ['ttl_extend', 'landed', job.target.mandate, t.scope],
    ]);
  });

  it('restores an entry whose time to live has passed, then extends it', async () => {
    const t = setup();
    const { key, put, latest, ports, job, metrics } = world(t);
    put(key('balance'), latest - 1);
    const result = await runTtlKeepAlive(job, CONFIG, ports);
    expect(result).toMatchObject({ archived: 1, restored: 1, extended: 1 });
    expect(sent(t).map((s) => [s.type, s.readOnly, s.readWrite])).toEqual([
      ['restoreFootprint', [], [key('balance')]],
      ['extendFootprintTtl', [key('balance')], []],
    ]);
    expect(metrics.total('ttl_archived_entries_found')).toBe(1);
    expect([...t.store.submissions.values()].map((r) => r.op)).toEqual(['restore', 'ttl_extend']);
  });

  it('leaves alone an entry at exactly the latest ledger, or one that does not expire', async () => {
    const t = setup();
    const { key, put, latest, ports, job } = world(t);
    put(key('instance'));
    const read = await ports.reader.readTtl(
      NETWORK,
      [key('instance'), key('balance')],
      new AbortController().signal,
    );
    expect(read.entries[0]).toMatchObject({ state: 'live' });
    put(key('balance'), latest);
    const result = await runTtlKeepAlive(job, CONFIG, ports);
    expect(result).toMatchObject({ archived: 0, belowThreshold: 1 });
    expect(sent(t).map((s) => s.readOnly)).toEqual([[key('balance')]]);
  });

  it('reports a key the node does not return, and sends nothing for it', async () => {
    const t = setup();
    const { key, ports, job, metrics } = world(t);
    t.rpc.entries.delete(key('balance'));
    const result = await runTtlKeepAlive(job, CONFIG, ports);
    expect(result).toMatchObject({ missing: 1, extended: 0 });
    expect(metrics.total('ttl_entries_missing')).toBe(1);
    expect(t.rpc.sent).toEqual([]);
  });
});
