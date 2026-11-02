// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the reloader (reload.ts).
 *
 * - start() loads the active version and then polls every 30 seconds; it
 *   throws when nothing valid could be loaded.
 * - current() returns the snapshot to route with: version, frozen config
 *   and load time. It throws RoutingConfigUnavailableError before the first
 *   successful load.
 * - A poll reads the active pointer. Same version: nothing else happens.
 *   New version: it is fetched, validated and swapped in by one assignment.
 * - An invalid active version leaves the previous snapshot in place and
 *   raises invalidActiveVersion once per move of the pointer onto it.
 * - A store failure, timeout, missing pointer or missing version leaves the
 *   previous snapshot in place and raises loadFailed on every poll.
 * - Polls never overlap.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_MARKED_VERSION, markedDocument, routingDocument } from '../test/fixtures.js';
import {
  POLL_INTERVAL_MS,
  RoutingConfigInvalidError,
  RoutingConfigReloader,
  RoutingConfigStoreError,
  RoutingConfigStoreTimeoutError,
  RoutingConfigUnavailableError,
  RoutingConfigVersionNotFoundError,
  activateRoutingConfig,
  createMemoryRoutingConfigStore,
  publishRoutingConfig,
} from './index.js';
import type {
  MemoryRoutingConfigStore,
  RoutingConfigAlerts,
  RoutingConfigStore,
  RoutingSnapshot,
} from './index.js';

function recordingAlerts() {
  const invalid: Parameters<RoutingConfigAlerts['invalidActiveVersion']>[0][] = [];
  const failed: Parameters<RoutingConfigAlerts['loadFailed']>[0][] = [];
  const alerts: RoutingConfigAlerts = {
    invalidActiveVersion: (e) => invalid.push(e),
    loadFailed: (e) => failed.push(e),
  };
  return { alerts, invalid, failed };
}

async function publish(store: RoutingConfigStore, document: unknown): Promise<number> {
  const { version } = await publishRoutingConfig(store, { document, createdBy: 'ops_1' });
  return version;
}

async function storeWithActive(
  document: unknown = routingDocument(),
): Promise<MemoryRoutingConfigStore> {
  const store = createMemoryRoutingConfigStore();
  await activateRoutingConfig(store, await publish(store, document));
  return store;
}

// A version that passed an older schema, written straight to the store.
async function writeInvalid(store: RoutingConfigStore): Promise<number> {
  const document = routingDocument();
  document.corridors[0]?.candidates.push({ rail: 'anchor_gone', priority: 3 });
  const { version } = await store.insertVersion(
    { document, createdBy: 'ops_1' },
    { signal: new AbortController().signal },
  );
  return version;
}

const never = <T>(): Promise<T> =>
  new Promise<T>(() => {
    // Never settles, like a connection that hangs.
  });

afterEach(() => {
  vi.useRealTimers();
});

it('readers never see a half-applied snapshot', async () => {
  const store = createMemoryRoutingConfigStore();
  for (let v = 1; v <= MAX_MARKED_VERSION; v += 1) {
    expect(await publish(store, markedDocument(v))).toBe(v);
  }
  await activateRoutingConfig(store, 1);
  // Each fetch completes after a random delay, so swaps land while readers
  // are midway through a snapshot.
  const slow: RoutingConfigStore = {
    ...store,
    getVersion: async (version, opts) => {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
      return store.getVersion(version, opts);
    },
  };
  const { alerts, invalid, failed } = recordingAlerts();
  const reloader = new RoutingConfigReloader({ store: slow, alerts });
  await reloader.start();
  reloader.stop();

  const consistent = (snap: RoutingSnapshot): void => {
    const v = snap.version;
    expect(snap.config.corridors).toHaveLength(v);
    for (const corridor of snap.config.corridors) {
      for (const choice of corridor.candidates) expect(choice.priority).toBe(v);
    }
    expect(snap.config.rails.find((r) => r.id === 'wallet')?.enabled).toBe(v % 2 === 0);
  };

  let writing = true;
  const seen = new Set<number>();
  const reader = async (): Promise<void> => {
    while (writing) {
      const snap = reloader.current();
      seen.add(snap.version);
      consistent(snap);
      // Yield midway, as a real decision awaits quotes, then check the same
      // snapshot again: nothing may have changed under the reader.
      await new Promise((resolve) => setImmediate(resolve));
      consistent(snap);
      expect(() => {
        (snap.config.corridors as unknown[]).push({});
      }).toThrow(TypeError);
    }
  };
  const writer = async (): Promise<void> => {
    const order = [3, 7, 2, 12, 5, 1, 9, 4, 11, 6, 8, 10, 2, 12];
    try {
      for (const v of order) {
        await activateRoutingConfig(store, v);
        // Overlapping polls share one load.
        const [a, b] = await Promise.all([reloader.poll(), reloader.poll()]);
        expect(a).toBe(b);
        expect(reloader.current().version).toBe(v);
      }
    } finally {
      writing = false;
    }
  };
  await Promise.all([reader(), reader(), reader(), writer()]);
  expect(seen.size).toBeGreaterThan(1);
  expect(invalid).toEqual([]);
  expect(failed).toEqual([]);
});

it('invalid active version keeps previous and alerts', async () => {
  const store = await storeWithActive();
  const { alerts, invalid, failed } = recordingAlerts();
  const reloader = new RoutingConfigReloader({ store, alerts });
  const first = await reloader.start();
  reloader.stop();

  const bad = await writeInvalid(store);
  store.forceActive(bad);
  const outcome = await reloader.poll();

  expect(outcome).toMatchObject({ kind: 'rejected', version: bad, kept: first.version });
  expect(reloader.current()).toBe(first);
  expect(invalid).toEqual([
    {
      version: bad,
      issues: ['corridors.0.candidates.2.rail (unknown_rail)'],
      keptVersion: first.version,
    },
  ]);
  expect(failed).toEqual([]);

  // Still bad on the next poll: same answer, no second alert.
  expect(await reloader.poll()).toMatchObject({ kind: 'rejected', version: bad });
  expect(invalid).toHaveLength(1);

  // A good version clears it, and moving back onto the bad one alerts again.
  const good = await publish(store, routingDocument());
  await activateRoutingConfig(store, good);
  expect(await reloader.poll()).toEqual({
    kind: 'applied',
    version: good,
    previous: first.version,
  });
  store.forceActive(bad);
  expect(await reloader.poll()).toMatchObject({ kind: 'rejected', version: bad, kept: good });
  expect(invalid).toHaveLength(2);
  expect(reloader.current().version).toBe(good);
});

describe('RoutingConfigReloader', () => {
  it('applies a new version within one poll interval', async () => {
    vi.useFakeTimers();
    const store = await storeWithActive();
    const { alerts } = recordingAlerts();
    const reloader = new RoutingConfigReloader({ store, alerts });
    expect((await reloader.start()).version).toBe(1);

    const next = await publish(store, markedDocument(2));
    await activateRoutingConfig(store, next);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(reloader.current().version).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reloader.current().version).toBe(next);
    expect(reloader.current().config.corridors).toHaveLength(2);

    // And keeps polling after that.
    await activateRoutingConfig(store, 1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(reloader.current().version).toBe(1);

    reloader.stop();
    await activateRoutingConfig(store, next);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(reloader.current().version).toBe(1);
  });

  it('honours a custom interval and a second start', async () => {
    vi.useFakeTimers();
    const store = await storeWithActive();
    const reloader = new RoutingConfigReloader({
      store,
      alerts: recordingAlerts().alerts,
      pollIntervalMs: 1_000,
    });
    await reloader.start();
    await reloader.start();
    await activateRoutingConfig(store, await publish(store, markedDocument(3)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reloader.current().version).toBe(2);
    reloader.stop();
    reloader.stop();
  });

  it('records when the snapshot was loaded', async () => {
    const store = await storeWithActive();
    const at = new Date('2026-10-31T12:00:00Z');
    const reloader = new RoutingConfigReloader({
      store,
      alerts: recordingAlerts().alerts,
      now: () => at,
    });
    const snap = await reloader.start();
    reloader.stop();
    expect(snap.loadedAt).toBe(at);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('reads only the pointer while the version is unchanged', async () => {
    const store = await storeWithActive();
    const getVersion = vi.spyOn(store, 'getVersion');
    const reloader = new RoutingConfigReloader({ store, alerts: recordingAlerts().alerts });
    const snap = await reloader.start();
    reloader.stop();
    expect(await reloader.poll()).toEqual({ kind: 'unchanged', version: 1 });
    expect(await reloader.poll()).toEqual({ kind: 'unchanged', version: 1 });
    expect(getVersion).toHaveBeenCalledTimes(1);
    expect(reloader.current()).toBe(snap);
  });

  it('rolls back by activating an older version', async () => {
    const store = await storeWithActive(markedDocument(1));
    const reloader = new RoutingConfigReloader({ store, alerts: recordingAlerts().alerts });
    await reloader.start();
    reloader.stop();
    await activateRoutingConfig(store, await publish(store, markedDocument(2)));
    await reloader.poll();
    await activateRoutingConfig(store, 1);
    expect(await reloader.poll()).toEqual({ kind: 'applied', version: 1, previous: 2 });
    expect(reloader.current().config.corridors).toHaveLength(1);
  });

  it('throws from current() until something is loaded', () => {
    const reloader = new RoutingConfigReloader({
      store: createMemoryRoutingConfigStore(),
      alerts: recordingAlerts().alerts,
    });
    expect(() => reloader.current()).toThrow(RoutingConfigUnavailableError);
  });

  it('refuses to start with no active version', async () => {
    const { alerts, failed } = recordingAlerts();
    const reloader = new RoutingConfigReloader({ store: createMemoryRoutingConfigStore(), alerts });
    await expect(reloader.start()).rejects.toThrow(RoutingConfigUnavailableError);
    expect(failed).toEqual([{ code: 'ROUTING_CONFIG_UNAVAILABLE', keptVersion: null }]);
  });

  it('refuses to start on an invalid active version', async () => {
    const store = createMemoryRoutingConfigStore();
    store.forceActive(await writeInvalid(store));
    const { alerts, invalid } = recordingAlerts();
    const reloader = new RoutingConfigReloader({ store, alerts });
    await expect(reloader.start()).rejects.toThrow(RoutingConfigInvalidError);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.keptVersion).toBeNull();
  });

  it('keeps the snapshot and alerts when the store hangs', async () => {
    const store = await storeWithActive();
    const { alerts, failed } = recordingAlerts();
    const hanging: RoutingConfigStore = { ...store, readActivePointer: () => never() };
    let healthy = true;
    const switching: RoutingConfigStore = {
      ...store,
      readActivePointer: (opts) =>
        healthy ? store.readActivePointer(opts) : hanging.readActivePointer(opts),
    };
    const reloader = new RoutingConfigReloader({ store: switching, alerts, storeTimeoutMs: 20 });
    const snap = await reloader.start();
    reloader.stop();
    healthy = false;
    const outcome = await reloader.poll();
    expect(outcome).toMatchObject({ kind: 'failed', kept: 1 });
    expect(outcome.kind === 'failed' && outcome.error).toBeInstanceOf(
      RoutingConfigStoreTimeoutError,
    );
    expect(reloader.current()).toBe(snap);
    expect(failed).toEqual([{ code: 'ROUTING_CONFIG_STORE_TIMEOUT', keptVersion: 1 }]);
  });

  it('aborts the store call when it times out', async () => {
    const store = await storeWithActive();
    let seen: AbortSignal | undefined;
    const reloader = new RoutingConfigReloader({
      store: {
        ...store,
        readActivePointer: ({ signal }) => {
          seen = signal;
          return never();
        },
      },
      alerts: recordingAlerts().alerts,
      storeTimeoutMs: 10,
    });
    await reloader.poll();
    expect(seen?.aborted).toBe(true);
  });

  it('keeps the snapshot and alerts on every failed poll when the store throws', async () => {
    const store = await storeWithActive();
    const { alerts, failed } = recordingAlerts();
    const cause = new Error('connection refused');
    let healthy = true;
    const flaky: RoutingConfigStore = {
      ...store,
      readActivePointer: (opts) =>
        healthy ? store.readActivePointer(opts) : Promise.reject(cause),
    };
    const reloader = new RoutingConfigReloader({ store: flaky, alerts });
    const snap = await reloader.start();
    reloader.stop();
    healthy = false;
    const outcome = await reloader.poll();
    expect(outcome.kind).toBe('failed');
    const error = outcome.kind === 'failed' ? outcome.error : undefined;
    expect(error).toBeInstanceOf(RoutingConfigStoreError);
    expect(error?.cause).toBe(cause);
    await reloader.poll();
    expect(failed).toHaveLength(2);
    expect(reloader.current()).toBe(snap);
  });

  it('keeps the snapshot when the pointer names a version that does not exist', async () => {
    const store = await storeWithActive();
    const { alerts, failed } = recordingAlerts();
    const dangling: RoutingConfigStore = {
      ...store,
      readActivePointer: () => Promise.resolve(99),
    };
    let useDangling = false;
    const reloader = new RoutingConfigReloader({
      store: {
        ...store,
        readActivePointer: (opts) =>
          useDangling ? dangling.readActivePointer(opts) : store.readActivePointer(opts),
      },
      alerts,
    });
    await reloader.start();
    reloader.stop();
    useDangling = true;
    const outcome = await reloader.poll();
    expect(outcome.kind === 'failed' && outcome.error).toBeInstanceOf(
      RoutingConfigVersionNotFoundError,
    );
    expect(failed).toEqual([{ code: 'ROUTING_CONFIG_VERSION_NOT_FOUND', keptVersion: 1 }]);
    expect(reloader.current().version).toBe(1);
  });

  it('wraps a store that throws synchronously', async () => {
    const store = await storeWithActive();
    const { alerts, failed } = recordingAlerts();
    const reloader = new RoutingConfigReloader({
      store: {
        ...store,
        readActivePointer: () => {
          throw new TypeError('driver bug');
        },
      },
      alerts,
    });
    const outcome = await reloader.poll();
    expect(outcome.kind === 'failed' && outcome.error).toBeInstanceOf(RoutingConfigStoreError);
    expect(failed).toEqual([{ code: 'ROUTING_CONFIG_STORE_FAILED', keptVersion: null }]);
  });

  it('keeps polling when an alert sink throws, and hands the failure on', async () => {
    vi.useFakeTimers();
    const store = await storeWithActive();
    const pointer = vi.spyOn(store, 'readActivePointer');
    const boom = new Error('alert sink down');
    const surfaced: unknown[] = [];
    const reloader = new RoutingConfigReloader({
      store,
      alerts: {
        invalidActiveVersion: () => {
          throw boom;
        },
        loadFailed: () => undefined,
      },
      onLoopError: (err) => surfaced.push(err),
    });
    await reloader.start();
    store.forceActive(await writeInvalid(store));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(surfaced).toEqual([boom]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    reloader.stop();
    expect(pointer).toHaveBeenCalledTimes(3);
    expect(reloader.current().version).toBe(1);
  });
});
