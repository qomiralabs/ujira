// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The executor's and payouts worker's check (compliance.ts). guardSubmission
 * parks a job as blocked_by_policy while the instance is marked, atomically
 * with the mark, and otherwise says submit. Parking twice keeps one entry. A
 * store failure throws, so nothing is submitted and the worker's bounded
 * retry applies.
 */

import { describe, expect, it } from 'vitest';

import { key } from '../test/world.js';
import {
  BLOCKED_BY_POLICY,
  PolicyStoreError,
  createMemoryComplianceStore,
  guardSubmission,
} from './index.js';
import type { ComplianceNotice, ComplianceStore, InstanceKey } from './index.js';

const OPTS = { signal: new AbortController().signal };
const AT = new Date('2026-11-02T00:00:00Z');
const KEY: InstanceKey = {
  principalId: key().principalId,
  projectId: key().projectId,
  instanceId: 'a',
};
const notice: ComplianceNotice = { key: KEY, to: 'noncompliant', at: AT, fixes: [] };
const MARK = { reason: 'principal_key_risk', since: AT } as const;

describe('executor', () => {
  it('noncompliant mandate jobs are parked as blocked_by_policy', async () => {
    const compliance = createMemoryComplianceStore();
    await compliance.applyMark(KEY, MARK, notice, OPTS);
    expect(await guardSubmission(KEY, 'job-1', { compliance })).toEqual({
      action: 'park',
      status: BLOCKED_BY_POLICY,
    });
    expect(BLOCKED_BY_POLICY).toBe('blocked_by_policy');
    expect(compliance.parked(KEY)).toEqual(['job-1']);
  });

  it('parks a job once however often it is retried', async () => {
    const compliance = createMemoryComplianceStore();
    await compliance.applyMark(KEY, MARK, notice, OPTS);
    await guardSubmission(KEY, 'job-1', { compliance });
    await guardSubmission(KEY, 'job-1', { compliance });
    expect(compliance.parked(KEY)).toEqual(['job-1']);
  });

  it('submits when the mandate is not marked, and parks nothing', async () => {
    const compliance = createMemoryComplianceStore();
    expect(await guardSubmission(KEY, 'job-1', { compliance })).toEqual({ action: 'submit' });
    expect(compliance.parked(KEY)).toEqual([]);
  });

  it('submits nothing when the store fails', async () => {
    const failing: ComplianceStore = {
      ...createMemoryComplianceStore(),
      parkIfNoncompliant: () => Promise.reject(new Error('db down')),
    };
    await expect(guardSubmission(KEY, 'job-1', { compliance: failing })).rejects.toThrow(
      PolicyStoreError,
    );
  });

  it('resumes a job parked before the mark cleared, and only then', async () => {
    const compliance = createMemoryComplianceStore();
    await compliance.applyMark(KEY, MARK, notice, OPTS);
    await guardSubmission(KEY, 'job-1', { compliance });
    expect(compliance.resumed).toEqual([]);
    await compliance.applyMark(KEY, null, { ...notice, to: 'compliant' }, OPTS);
    expect(compliance.resumed).toEqual(['job-1']);
    // A second clear changes nothing and resumes nothing.
    expect(await compliance.applyMark(KEY, null, { ...notice, to: 'compliant' }, OPTS)).toBe(false);
    expect(compliance.resumed).toEqual(['job-1']);
  });
});
