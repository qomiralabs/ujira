// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { jobPayloadProblems } from '@ujira/db';
import { jobsIn } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobPayloadError } from './errors.js';
import {
  SYSTEM_TASKS,
  TENANT_TASKS,
  enqueueTask,
  parseTaskPayload,
  PAYOUT_ADVANCE,
} from './tasks.js';
import { newTenant, workerHarness, type WorkerHarness } from './testing/support.js';

const TENANT = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
};
const VALID = { ...TENANT, payoutId: 'p1', mandateId: 'm1' };

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
});

afterAll(async () => {
  await harness.close();
});

describe('the task registry', () => {
  it('every job payload has ids only', async () => {
    const registry = Object.fromEntries(
      TENANT_TASKS.map((task) => [task.name, [...task.ids, 'try']]),
    );
    expect(Object.keys(registry)).toEqual([
      'payout:advance',
      'batch:advance',
      'payouts:release_held',
      'mandate:reconcile',
      'ttl:keep_alive',
    ]);
    expect(jobPayloadProblems(registry)).toEqual([]);

    // And what the database really stores is exactly that, plus the tenant it adds.
    const tenant = await newTenant(harness.db);
    await harness.db
      .tenant(tenant)
      .transaction(async (tx) =>
        enqueueTask(tx, PAYOUT_ADVANCE, { payoutId: 'p1', mandateId: 'm1' }, { tryNumber: 2 }),
      );
    const [job] = await jobsIn(harness.database.url);
    expect(job?.payload).toEqual({
      payoutId: 'p1',
      mandateId: 'm1',
      try: '2',
      principalId: tenant.principalId,
      projectId: tenant.projectId,
    });
    const prefix = `${tenant.principalId}:${tenant.projectId}:`;
    expect(job?.key).toBe(`${prefix}payout:p1`);
    expect(job?.queue_name).toBe(`${prefix}mandate:m1`);
  });

  it('names every task with colons, which the crontab parser needs', () => {
    const names = [...TENANT_TASKS.map((task) => task.name), ...Object.values(SYSTEM_TASKS)];
    expect(names).toContain('payout:advance');
    expect(names).toContain('batch:advance');
    expect(names).toContain('indexer:scan');
    expect(names).toContain('reconcile:sweep');
    expect(names).toContain('mandate:reconcile');
    expect(names).toContain('jobs:unlock_stale');
    for (const name of names) expect(name).toMatch(/^[a-z_]+:[a-z_]+$/);
  });
});

describe('parseTaskPayload', () => {
  it('reads the tenant, the ids and the try', () => {
    expect(parseTaskPayload(PAYOUT_ADVANCE, { ...VALID, try: '3' })).toEqual({
      context: TENANT,
      ids: { payoutId: 'p1', mandateId: 'm1' },
      tryNumber: 3,
    });
  });

  it('starts at the first try', () => {
    expect(parseTaskPayload(PAYOUT_ADVANCE, VALID).tryNumber).toBe(1);
  });

  it.each([
    ['a field nobody declared', { ...VALID, recipientEmail: 'a@example.com' }],
    ['a missing id', { ...TENANT, payoutId: 'p1' }],
    ['a missing tenant', { payoutId: 'p1', mandateId: 'm1' }],
    ['a tenant that is not a uuid', { ...VALID, principalId: 'acme' }],
    ['an id that is not a string', { ...VALID, payoutId: 1 }],
    ['an empty id', { ...VALID, payoutId: '' }],
    ['a try of zero', { ...VALID, try: '0' }],
    ['a try that is not a number', { ...VALID, try: 'x' }],
    ['a try that is a number', { ...VALID, try: 2 }],
    ['something that is not an object', 'payout'],
  ])('refuses %s', (_name, payload) => {
    expect(() => parseTaskPayload(PAYOUT_ADVANCE, payload)).toThrow(JobPayloadError);
  });

  it('does not repeat the payload in its error', () => {
    expect(() =>
      parseTaskPayload(PAYOUT_ADVANCE, { ...VALID, recipientEmail: 'a@example.com' }),
    ).toThrow(/^the payload of a payout:advance job is not valid$/);
  });
});
