// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for writing and activating versions (admin.ts) and the
 * in-memory store (store.ts).
 *
 * - publishRoutingConfig validates, then stores a new inactive version. An
 *   invalid document or an operator ID that is not an opaque ID is refused
 *   before anything is written.
 * - activateRoutingConfig validates the stored version again and only then
 *   moves the pointer. An unknown version is RoutingConfigVersionNotFoundError.
 * - Every store call is bounded by a timeout (5 seconds by default) and
 *   failures come back typed.
 * - The memory store keeps immutable copies: changing a document after
 *   writing it, or a document read back, changes nothing stored.
 */

import { describe, expect, it } from 'vitest';

import { routingDocument } from '../test/fixtures.js';
import {
  RoutingConfigInvalidError,
  RoutingConfigStoreError,
  RoutingConfigStoreTimeoutError,
  RoutingConfigVersionNotFoundError,
  STORE_TIMEOUT_MS,
  activateRoutingConfig,
  createMemoryRoutingConfigStore,
  publishRoutingConfig,
} from './index.js';
import type { RoutingConfigStore } from './index.js';

const OPTS = { signal: new AbortController().signal };

function broken(): ReturnType<typeof routingDocument> {
  const doc = routingDocument();
  doc.corridors[0]?.candidates.push({ rail: 'anchor_z', priority: 3 });
  return doc;
}

describe('publishRoutingConfig', () => {
  it('stores a valid document as a new inactive version', async () => {
    const store = createMemoryRoutingConfigStore(() => new Date('2026-10-31T00:00:00Z'));
    const first = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'ops_1',
    });
    const second = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'ops-2',
    });
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(await store.readActivePointer(OPTS)).toBeNull();
    const record = await store.getVersion(2, OPTS);
    expect(record).toMatchObject({ version: 2, createdBy: 'ops-2' });
    expect(record?.createdAt.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(record?.document).toEqual(routingDocument());
  });

  it('refuses an invalid document before writing anything', async () => {
    const store = createMemoryRoutingConfigStore();
    await expect(
      publishRoutingConfig(store, { document: broken(), createdBy: 'ops_1' }),
    ).rejects.toThrow(RoutingConfigInvalidError);
    expect(await store.getVersion(1, OPTS)).toBeNull();
  });

  it.each(['ops@example.com', 'Jane Doe', 'JaneDoe', '', 'x'.repeat(65)])(
    'refuses %j as the operator',
    async (createdBy) => {
      const store = createMemoryRoutingConfigStore();
      const err: unknown = await publishRoutingConfig(store, {
        document: routingDocument(),
        createdBy,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RoutingConfigInvalidError);
      expect((err as RoutingConfigInvalidError).issues).toEqual(['createdBy (invalid_format)']);
      expect(await store.getVersion(1, OPTS)).toBeNull();
    },
  );

  it('bounds the write with a timeout', async () => {
    const store: RoutingConfigStore = {
      ...createMemoryRoutingConfigStore(),
      insertVersion: () => new Promise(() => undefined),
    };
    await expect(
      publishRoutingConfig(
        store,
        { document: routingDocument(), createdBy: 'ops_1' },
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow(RoutingConfigStoreTimeoutError);
  });

  it('defaults the store timeout to five seconds', () => {
    expect(STORE_TIMEOUT_MS).toBe(5_000);
  });
});

describe('activateRoutingConfig', () => {
  it('moves the pointer to a valid version', async () => {
    const store = createMemoryRoutingConfigStore();
    const { version } = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'ops_1',
    });
    await activateRoutingConfig(store, version);
    expect(await store.readActivePointer(OPTS)).toBe(version);
  });

  it('refuses a stored version that no longer validates', async () => {
    const store = createMemoryRoutingConfigStore();
    const good = await publishRoutingConfig(store, {
      document: routingDocument(),
      createdBy: 'ops_1',
    });
    await activateRoutingConfig(store, good.version);
    const bad = await store.insertVersion({ document: broken(), createdBy: 'ops_1' }, OPTS);
    await expect(activateRoutingConfig(store, bad.version)).rejects.toThrow(
      RoutingConfigInvalidError,
    );
    expect(await store.readActivePointer(OPTS)).toBe(good.version);
  });

  it('refuses an unknown version', async () => {
    await expect(activateRoutingConfig(createMemoryRoutingConfigStore(), 7)).rejects.toThrow(
      RoutingConfigVersionNotFoundError,
    );
  });

  it('reports a failing store as a typed error with its cause', async () => {
    const cause = new Error('connection reset');
    const store: RoutingConfigStore = {
      ...createMemoryRoutingConfigStore(),
      getVersion: () => Promise.reject(cause),
    };
    const err: unknown = await activateRoutingConfig(store, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoutingConfigStoreError);
    expect((err as Error).cause).toBe(cause);
  });

  it('bounds the pointer write with a timeout', async () => {
    const memory = createMemoryRoutingConfigStore();
    const { version } = await publishRoutingConfig(memory, {
      document: routingDocument(),
      createdBy: 'ops_1',
    });
    const store: RoutingConfigStore = { ...memory, activate: () => new Promise(() => undefined) };
    await expect(activateRoutingConfig(store, version, { timeoutMs: 10 })).rejects.toThrow(
      RoutingConfigStoreTimeoutError,
    );
  });
});

describe('createMemoryRoutingConfigStore', () => {
  it('keeps what was written when the caller changes its copy', async () => {
    const store = createMemoryRoutingConfigStore();
    const doc = routingDocument();
    const { version } = await store.insertVersion({ document: doc, createdBy: 'ops_1' }, OPTS);
    doc.rails = [];
    const read = await store.getVersion(version, OPTS);
    expect(read?.document).toEqual(routingDocument());
    (read?.document as { rails: unknown[] }).rails.length = 0;
    expect((await store.getVersion(version, OPTS))?.document).toEqual(routingDocument());
  });

  it('refuses to point at a version it does not hold', async () => {
    const store = createMemoryRoutingConfigStore();
    expect(() => {
      store.forceActive(1);
    }).toThrow(RangeError);
    await expect(store.activate(1, OPTS)).rejects.toThrow(RangeError);
    expect(await store.readActivePointer(OPTS)).toBeNull();
  });
});
