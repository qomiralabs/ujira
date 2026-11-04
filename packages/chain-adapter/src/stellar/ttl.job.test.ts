// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The keep-alive job against a fake ledger that models time to live,
// archiving, restores and extensions. It must extend only what is close to
// lapsing, restore before it extends, never submit the same step twice in
// one ledger window, and keep every tenant's steps apart.

import { describe, expect, it } from 'vitest';

import { STRKEY_VERSION, encodeStrkey } from '../codecs/strkey.js';
import {
  InvalidInputError,
  RpcTimeoutError,
  SubmissionRejectedError,
  SubmissionUnknownError,
} from '../errors.js';
import { FakeTtlLedger, MemoryTtlStepStore, RecordingTtlMetrics } from '../testing/ttl.js';
import type { Bytes32, TenantScope } from '../types.js';

import {
  TTL_KEEP_ALIVE_TASK,
  parseTtlConfig,
  runTtlKeepAlive,
  ttlKeepAliveTask,
} from './ttl-job.js';
import type { TtlConfig, TtlKeepAliveJob, TtlPorts } from './ttl-job.js';
import { keepAliveKeys } from './ttl-keys.js';
import type { KeepAliveTarget } from './ttl-keys.js';

const NETWORK = 'stellar:testnet' as const;
const SCOPE: TenantScope = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
} as TenantScope;
const OTHER: TenantScope = {
  principalId: '0199a1f6-9999-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-8888-7a55-8e21-5b9c7d3e1f04',
} as TenantScope;

const id = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const TARGET: KeepAliveTarget = {
  mandate: encodeStrkey(STRKEY_VERSION.contract, id(1)),
  asset: encodeStrkey(STRKEY_VERSION.contract, id(2)),
  wasmHash: '03'.repeat(32),
  allowed: [],
  daily: [`0x${'04'.repeat(32)}` as Bytes32, `0x${'05'.repeat(32)}` as Bytes32],
};
const KEYS = keepAliveKeys(TARGET);
const key = (kind: string, n = 0): string =>
  KEYS.filter((k) => k.kind === kind)[n]?.xdr ?? 'missing';

const CONFIG: TtlConfig = parseTtlConfig({
  thresholdLedgers: 100_000,
  extendToLedgers: 500_000,
  windowLedgers: 17_280,
  maxKeysPerTransaction: 10,
  rpcTimeoutMs: 1_000,
  submitTimeoutMs: 1_000,
});

const LATEST = 1_000_000;

function setup(
  scope: TenantScope = SCOPE,
  shared?: { ledger: FakeTtlLedger; store: MemoryTtlStepStore },
) {
  const ledger =
    shared?.ledger ?? new FakeTtlLedger({ latestLedger: LATEST, restoredTtlLedgers: 4_096 });
  // Everything comfortably alive unless a test says otherwise.
  if (shared === undefined) for (const k of KEYS) ledger.put(k.xdr, LATEST + 400_000);
  const store = shared?.store ?? new MemoryTtlStepStore();
  const metrics = new RecordingTtlMetrics();
  const ports: TtlPorts = { reader: ledger, submitter: ledger, store, metrics };
  const job: TtlKeepAliveJob = { scope, network: NETWORK, target: TARGET };
  return { ledger, store, metrics, ports, job };
}

describe('ttl.job.test.ts', () => {
  it('extends only entries below threshold', async () => {
    const { ledger, metrics, ports, job } = setup();
    ledger.put(key('balance'), LATEST + 10);
    ledger.put(key('daily', 1), LATEST + 99_999);
    const result = await runTtlKeepAlive(job, CONFIG, ports);
    expect(ledger.calls).toEqual([
      { action: 'extend', keys: [key('balance'), key('daily', 1)], extendToLedgers: 500_000 },
    ]);
    expect(result).toMatchObject({
      checked: KEYS.length,
      belowThreshold: 2,
      archived: 0,
      extended: 2,
    });
    expect(ledger.liveUntil(key('balance'))).toBe(LATEST + 500_000);
    // Untouched entries keep their TTL.
    expect(ledger.liveUntil(key('instance'))).toBe(LATEST + 400_000);
    expect(metrics.total('ttl_entries_below_threshold')).toBe(2);
    expect(metrics.labels('ttl_entries_below_threshold')).toEqual([
      { principalId: SCOPE.principalId, projectId: SCOPE.projectId, network: NETWORK },
    ]);
  });

  it('submits nothing when every entry is comfortably alive', async () => {
    const { ledger, ports, job } = setup();
    const result = await runTtlKeepAlive(job, CONFIG, ports);
    expect(ledger.calls).toEqual([]);
    expect(result).toMatchObject({ belowThreshold: 0, extended: 0, restored: 0 });
  });

  it('restores then extends an archived entry', async () => {
    const { ledger, metrics, ports, job } = setup();
    ledger.archive(key('balance'));
    const result = await runTtlKeepAlive(job, CONFIG, ports);
    expect(ledger.calls).toEqual([
      { action: 'restore', keys: [key('balance')] },
      { action: 'extend', keys: [key('balance')], extendToLedgers: 500_000 },
    ]);
    expect(result).toMatchObject({ archived: 1, restored: 1, extended: 1 });
    expect(ledger.isArchived(key('balance'))).toBe(false);
    expect(ledger.liveUntil(key('balance'))).toBe(LATEST + 500_000);
    expect(metrics.total('ttl_archived_entries_found')).toBe(1);
  });

  it('a retried job in the same window submits once', async () => {
    const { ledger, ports, job } = setup();
    ledger.put(key('balance'), LATEST + 10);
    // The extension lands but the RPC node the retry reads from lags behind.
    ledger.lagReads = true;
    await runTtlKeepAlive(job, CONFIG, ports);
    const again = await runTtlKeepAlive(job, CONFIG, ports);
    expect(ledger.calls).toHaveLength(1);
    expect(again).toMatchObject({ extended: 0, alreadySubmitted: 1 });
    // A later window is a new step.
    ledger.advance(CONFIG.windowLedgers);
    ledger.lagReads = false;
    ledger.put(key('balance'), ledger.latestLedger + 10);
    await runTtlKeepAlive(job, CONFIG, ports);
    expect(ledger.calls).toHaveLength(2);
  });

  it('retries a step that definitely failed, inside the same window', async () => {
    const { ledger, metrics, ports, job } = setup();
    ledger.put(key('balance'), LATEST + 10);
    ledger.failNext('extend', new SubmissionRejectedError({ network: NETWORK }));
    await expect(runTtlKeepAlive(job, CONFIG, ports)).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );
    expect(metrics.total('ttl_extension_failed')).toBe(1);
    await runTtlKeepAlive(job, CONFIG, ports);
    expect(ledger.calls.filter((c) => c.action === 'extend')).toHaveLength(2);
    expect(ledger.liveUntil(key('balance'))).toBe(LATEST + 500_000);
  });

  it('does not resubmit a step whose outcome is unknown', async () => {
    const { ledger, metrics, ports, job } = setup();
    ledger.put(key('balance'), LATEST + 10);
    ledger.failNext('extend', new TypeError('socket hang up'));
    const err: unknown = await runTtlKeepAlive(job, CONFIG, ports).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionUnknownError);
    expect(metrics.total('ttl_extension_failed')).toBe(1);
    const again = await runTtlKeepAlive(job, CONFIG, ports);
    expect(ledger.calls.filter((c) => c.action === 'extend')).toHaveLength(1);
    expect(again).toMatchObject({ alreadySubmitted: 1 });
  });

  it('does not extend an archived entry while its restore is unresolved', async () => {
    const { ledger, ports, job } = setup();
    ledger.archive(key('balance'));
    ledger.put(key('instance'), LATEST + 10);
    ledger.failNext('restore', new SubmissionUnknownError({ network: NETWORK }));
    await expect(runTtlKeepAlive(job, CONFIG, ports)).rejects.toBeInstanceOf(
      SubmissionUnknownError,
    );
    const again = await runTtlKeepAlive(job, CONFIG, ports);
    // The live entry below threshold is still extended; the archived one waits.
    expect(ledger.calls.map((c) => c.action)).toEqual(['restore', 'extend']);
    expect(ledger.calls[1]?.keys).toEqual([key('instance')]);
    expect(again).toMatchObject({ waitingOnRestore: 1 });
  });

  it('splits a large set into transactions of the configured size', async () => {
    const { ledger, ports, job } = setup();
    for (const k of KEYS) ledger.put(k.xdr, LATEST + 1);
    const small = { ...CONFIG, maxKeysPerTransaction: 2 };
    const result = await runTtlKeepAlive(job, small, ports);
    expect(ledger.calls.map((c) => c.keys.length)).toEqual([2, 2, 1]);
    expect(result.extended).toBe(KEYS.length);
  });

  it('reports an entry the network does not have, and leaves it alone', async () => {
    const { ledger, metrics, ports, job } = setup();
    ledger.remove(key('daily', 0));
    const result = await runTtlKeepAlive(job, CONFIG, ports);
    expect(result).toMatchObject({ missing: 1 });
    expect(metrics.total('ttl_entries_missing')).toBe(1);
    expect(ledger.calls).toEqual([]);
  });

  it('keeps tenants apart: one tenant claiming a step never blocks another', async () => {
    const a = setup(SCOPE);
    a.ledger.put(key('balance'), LATEST + 10);
    a.ledger.lagReads = true;
    await runTtlKeepAlive(a.job, CONFIG, a.ports);
    const b = setup(OTHER, { ledger: a.ledger, store: a.store });
    await runTtlKeepAlive(b.job, CONFIG, b.ports);
    expect(a.ledger.calls).toHaveLength(2);
    expect(
      a.store
        .steps()
        .map((s) => s.scope.principalId)
        .sort(),
    ).toEqual([SCOPE.principalId, OTHER.principalId].sort());
  });

  it('times out a read that never answers, before anything is sent', async () => {
    const { ledger, ports, job } = setup();
    ledger.hangReads = true;
    const err: unknown = await runTtlKeepAlive(job, { ...CONFIG, rpcTimeoutMs: 20 }, ports).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect((err as RpcTimeoutError).landed).toBe('no');
    expect(ledger.calls).toEqual([]);
  });

  it('times out a submission as landed unknown and does not send it again', async () => {
    const { ledger, metrics, ports, job } = setup();
    ledger.put(key('balance'), LATEST + 10);
    ledger.hangSubmissions = true;
    const quick = { ...CONFIG, submitTimeoutMs: 20 };
    const err: unknown = await runTtlKeepAlive(job, quick, ports).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect((err as RpcTimeoutError).landed).toBe('unknown');
    expect(metrics.total('ttl_extension_failed')).toBe(1);
    ledger.hangSubmissions = false;
    const again = await runTtlKeepAlive(job, quick, ports);
    expect(again).toMatchObject({ alreadySubmitted: 1, extended: 0 });
  });

  it('uses a fake ledger that refuses what the network refuses', async () => {
    const { ledger } = setup();
    const req = { scope: SCOPE, network: NETWORK, mandate: TARGET.mandate };
    ledger.archive(key('balance'));
    await expect(
      ledger.extend({ ...req, keys: [key('balance')], extendToLedgers: 1 }),
    ).rejects.toBeInstanceOf(SubmissionRejectedError);
    await expect(ledger.restore({ ...req, keys: [key('instance')] })).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );
  });

  it('takes thresholds and targets from configuration and refuses a bad one', () => {
    for (const bad of [
      { ...CONFIG, extendToLedgers: CONFIG.thresholdLedgers },
      { ...CONFIG, thresholdLedgers: 0 },
      { ...CONFIG, extendToLedgers: 10_000_000 },
      { ...CONFIG, maxKeysPerTransaction: 0 },
      { ...CONFIG, rpcTimeoutMs: 0 },
      { ...CONFIG, extra: 1 },
    ]) {
      expect(() => parseTtlConfig(bad)).toThrow(InvalidInputError);
    }
  });

  it('runs as a queue task: loads the target for the tenant and refuses a bad payload', async () => {
    const { ledger, ports } = setup();
    ledger.put(key('balance'), LATEST + 10);
    const loads: unknown[] = [];
    const task = ttlKeepAliveTask({
      ...ports,
      config: CONFIG,
      targets: {
        load: (scope, network, mandate) => {
          loads.push({ scope, network, mandate });
          return Promise.resolve(TARGET);
        },
      },
    });
    expect(TTL_KEEP_ALIVE_TASK.name).toBe('chain_adapter.ttl_keep_alive');
    const payload = { ...SCOPE, network: NETWORK, mandate: TARGET.mandate };
    expect(TTL_KEEP_ALIVE_TASK.jobKey(payload)).toBe(
      `ttl:${SCOPE.principalId}:${SCOPE.projectId}:${NETWORK}:${TARGET.mandate}`,
    );
    await task(payload);
    expect(loads).toEqual([
      {
        scope: { principalId: SCOPE.principalId, projectId: SCOPE.projectId },
        network: NETWORK,
        mandate: TARGET.mandate,
      },
    ]);
    expect(ledger.calls).toHaveLength(1);
    const lying = ttlKeepAliveTask({
      ...ports,
      config: CONFIG,
      targets: {
        load: () => Promise.resolve({ ...TARGET, mandate: TARGET.asset }),
      },
    });
    await expect(lying(payload)).rejects.toBeInstanceOf(InvalidInputError);
    expect(ledger.calls).toHaveLength(1);
    for (const bad of [{}, { ...payload, mandate: 'GABC' }, { ...payload, extra: 1 }, null]) {
      await expect(task(bad)).rejects.toBeInstanceOf(InvalidInputError);
    }
  });
});
