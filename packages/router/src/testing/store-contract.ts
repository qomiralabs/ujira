// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What every routing configuration store must do, whatever holds the data, so
// the in-memory store the unit tests use cannot quietly behave differently
// from the one in production. The setup runs before each case and starts with
// no active version. Other versions may already exist, so cases read back only
// what they wrote and never assume a number.

import { beforeEach, describe, expect, it } from 'vitest';

import type { RoutingConfigStore } from '../store.js';

const OPTS = { signal: new AbortController().signal };
const DOCUMENT = { schemaVersion: 1, rails: [{ id: 'a', weight: 2 }], note: null, on: true };

export function describeRoutingConfigStore(
  name: string,
  setup: () => Promise<RoutingConfigStore>,
): void {
  describe(`${name} as a routing configuration store`, () => {
    let store: RoutingConfigStore;

    const insert = (document: unknown = DOCUMENT) =>
      store.insertVersion({ document, createdBy: 'contract' }, OPTS);

    beforeEach(async () => {
      store = await setup();
    });

    it('has no active version until one is activated', async () => {
      await insert();
      expect(await store.readActivePointer(OPTS)).toBeNull();
    });

    it('stores a document and gives it back unchanged', async () => {
      const { version } = await insert();
      const record = await store.getVersion(version, OPTS);
      expect(record?.version).toBe(version);
      expect(record?.document).toEqual(DOCUMENT);
      expect(record?.createdBy).toBe('contract');
      expect(record?.createdAt).toBeInstanceOf(Date);
    });

    it('does not validate: that is for the router, in and out', async () => {
      const { version } = await insert({ not: 'a routing document' });
      expect((await store.getVersion(version, OPTS))?.document).toEqual({
        not: 'a routing document',
      });
    });

    it('gives each version a new, higher number', async () => {
      const first = await insert();
      const second = await insert();
      expect(second.version).toBeGreaterThan(first.version);
    });

    it('answers null for a version that does not exist', async () => {
      const { version } = await insert();
      expect(await store.getVersion(version + 1_000, OPTS)).toBeNull();
    });

    it('moves the pointer, forward and back', async () => {
      const first = await insert();
      const second = await insert();
      await store.activate(first.version, OPTS);
      expect(await store.readActivePointer(OPTS)).toBe(first.version);
      await store.activate(second.version, OPTS);
      expect(await store.readActivePointer(OPTS)).toBe(second.version);
      await store.activate(first.version, OPTS);
      expect(await store.readActivePointer(OPTS)).toBe(first.version);
    });

    it('refuses to activate a version that does not exist, and keeps the pointer', async () => {
      const { version } = await insert();
      await store.activate(version, OPTS);
      await expect(store.activate(version + 1_000, OPTS)).rejects.toThrow();
      expect(await store.readActivePointer(OPTS)).toBe(version);
    });

    it('keeps what was written when the caller changes its copy', async () => {
      const mine = { rails: ['a'] };
      const { version } = await insert(mine);
      mine.rails.push('b');
      expect((await store.getVersion(version, OPTS))?.document).toEqual({ rails: ['a'] });
    });
  });
}
