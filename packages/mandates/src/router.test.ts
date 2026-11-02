// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The router's serving check (compliance.ts). servableInstances keeps only
 * the candidates with no mark, in order and whatever else they carry. A store
 * that cannot answer throws, so an outage selects nothing.
 */

import { describe, expect, it } from 'vitest';

import { key, usdc } from '../test/world.js';
import {
  PolicyStoreError,
  PolicyStoreTimeoutError,
  createMemoryComplianceStore,
  servableInstances,
} from './index.js';
import type { ComplianceNotice, ComplianceStore, InstanceKey } from './index.js';

const OPTS = { signal: new AbortController().signal };
const AT = new Date('2026-11-02T00:00:00Z');
const keyOf = (instanceId: string): InstanceKey => ({
  principalId: key().principalId,
  projectId: key().projectId,
  instanceId,
});
const notice = (k: InstanceKey): ComplianceNotice => ({
  key: k,
  to: 'noncompliant',
  at: AT,
  fixes: [],
});

describe('router', () => {
  it('never selects a noncompliant mandate', async () => {
    const compliance = createMemoryComplianceStore();
    await compliance.applyMark(
      keyOf('bad'),
      { reason: 'principal_key_risk', since: AT },
      notice(keyOf('bad')),
      OPTS,
    );
    const candidates = [
      { key: keyOf('good-1'), free: usdc(5n) },
      { key: keyOf('bad'), free: usdc(9n) },
      { key: keyOf('good-2'), free: usdc(1n) },
    ];
    const servable = await servableInstances(candidates, { compliance });
    expect(servable.map((c) => c.key.instanceId)).toEqual(['good-1', 'good-2']);
    expect(servable[0]?.free).toEqual(usdc(5n));
  });

  it('selects nothing when the store fails or hangs', async () => {
    const compliance = createMemoryComplianceStore();
    const failing: ComplianceStore = {
      ...compliance,
      read: () => Promise.reject(new Error('down')),
    };
    await expect(servableInstances([{ key: keyOf('a') }], { compliance: failing })).rejects.toThrow(
      PolicyStoreError,
    );
    const hanging: ComplianceStore = { ...compliance, read: () => new Promise(() => undefined) };
    await expect(
      servableInstances([{ key: keyOf('a') }], { compliance: hanging, timeoutMs: 10 }),
    ).rejects.toThrow(PolicyStoreTimeoutError);
  });

  it('has nothing to do with no candidates', async () => {
    const compliance = createMemoryComplianceStore();
    expect(await servableInstances([], { compliance })).toEqual([]);
  });
});
