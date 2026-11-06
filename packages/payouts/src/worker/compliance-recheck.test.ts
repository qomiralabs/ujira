// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// On a real pool with room for several jobs at once, so a recheck waits only because
// its principal's queue says so. The holdings and the chain are in memory, and a read
// can be held open, which is how a slow recheck is made.

import { setTimeout as sleep } from 'node:timers/promises';

import type { Uuid } from '@ujira/chain-adapter';
import { deadLetters, projects, type ProjectContext } from '@ujira/db';
import { adminQuery, jobsIn } from '@ujira/db/testing';
import {
  createMemoryComplianceStore,
  createMemoryPrincipalKeyReader,
  type ComplianceDeps,
  type InstanceKey,
  type InstanceView,
  type MemoryComplianceStore,
} from '@ujira/mandates';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ONE_USDC } from '../engine/testing/world.js';
import { usdc } from '../engine/testing/usdc.js';
import { complianceRecheck, scheduleRecheck } from './compliance-recheck.js';
import { tenantTask, type TenantWork, type WorkerAlert } from './handlers.js';
import { startWorker, unwiredTasks, type RunningWorker } from './start.js';
import { COMPLIANCE_RECHECK } from './tasks.js';
import {
  helpersFor,
  newTenant,
  quiet,
  until,
  workerHarness,
  type WorkerHarness,
} from './testing/support.js';

const PRINCIPAL_ADDRESS = { network: 'stellar:testnet', value: `G${'A'.repeat(55)}` } as const;
// Under and over the 50,000 USD line, for a principal with one key and no recovery set.
const UNDER = 40_000n * ONE_USDC;
const OVER = 60_000n * ONE_USDC;

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
});

afterEach(async () => {
  await adminQuery(harness.database.url, 'delete from graphile_worker._private_jobs');
});

afterAll(async () => {
  await harness.close();
});

interface Hold {
  readonly reached: Promise<void>;
  readonly open: () => void;
}

// A principal's holdings, one instance each, and the reads made of them. A read takes
// its snapshot when it starts, so a held read is an old reading by the time it lands.
function holdings() {
  const budgets = new Map<string, bigint>();
  const reads: string[] = [];
  const holds: (() => Promise<void>)[] = [];
  const view = (principalId: string, projectId: string, raw: bigint): InstanceView => ({
    instanceId: `instance:${principalId}`,
    projectId: projectId as Uuid,
    principal: PRINCIPAL_ADDRESS,
    totalBudget: usdc(raw),
    recovery: [],
    recoveryThreshold: 0,
  });
  const projectOf = new Map<string, string>();
  return {
    reads,
    set(tenant: ProjectContext, raw: bigint): void {
      budgets.set(tenant.principalId, raw);
      projectOf.set(tenant.principalId, tenant.projectId);
    },
    keyOf(tenant: ProjectContext): InstanceKey {
      return {
        principalId: tenant.principalId as Uuid,
        projectId: tenant.projectId as Uuid,
        instanceId: `instance:${tenant.principalId}`,
      };
    },
    // The next read waits until the test opens it.
    holdNext(): Hold {
      let reach = (): void => undefined;
      let open = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      holds.push(async () => {
        reach();
        await opened;
      });
      return { reached, open };
    },
    list: async (principalId: string): Promise<readonly InstanceView[]> => {
      const raw = budgets.get(principalId);
      const projectId = projectOf.get(principalId);
      const snapshot =
        raw === undefined || projectId === undefined ? [] : [view(principalId, projectId, raw)];
      reads.push(principalId);
      await holds.shift()?.();
      return snapshot;
    },
  };
}

interface Setup {
  readonly held: ReturnType<typeof holdings>;
  readonly compliance: MemoryComplianceStore;
  readonly deps: ComplianceDeps;
}

function setup(signing = createMemoryPrincipalKeyReader()): Setup {
  const held = holdings();
  const compliance = createMemoryComplianceStore();
  // Longer than any hold below, so a held read is slow and not a timeout.
  const deps: ComplianceDeps = { instances: held, signing, compliance, timeoutMs: 30_000 };
  return { held, compliance, deps };
}

// Counts the rechecks running at once for each principal, and the most there ever were.
function counted(work: TenantWork) {
  const running = new Map<string, number>();
  const most = new Map<string, number>();
  const finished: string[] = [];
  const wrapped: TenantWork = async (job) => {
    const principal = job.context.principalId;
    const now = (running.get(principal) ?? 0) + 1;
    running.set(principal, now);
    most.set(principal, Math.max(most.get(principal) ?? 0, now));
    try {
      await work(job);
    } finally {
      running.set(principal, (running.get(principal) ?? 1) - 1);
      finished.push(principal);
    }
  };
  return { wrapped, most, finished };
}

async function schedule(tenant: ProjectContext, event = 'limits_updated'): Promise<void> {
  await harness.db.tenant(tenant).transaction(async (tx) => scheduleRecheck(tx, event));
}

async function start(work: TenantWork): Promise<RunningWorker> {
  return startWorker({
    db: harness.db,
    alert: () => undefined,
    logger: quiet,
    crontabEnabled: false,
    concurrency: 3,
    handlers: { tenantTasks: [{ task: COMPLIANCE_RECHECK, work }] },
  });
}

const drained = async (): Promise<boolean> => (await jobsIn(harness.database.url)).length === 0;

describe('scheduling a recheck', () => {
  it('only the events that can change the answer schedule one', async () => {
    const tenant = await newTenant(harness.db);
    const ids = await harness.db
      .tenant(tenant)
      .transaction(async (tx) => [
        await scheduleRecheck(tx, 'payout_executed'),
        await scheduleRecheck(tx, 'limits_updated'),
      ]);
    expect(ids[0]).toBeNull();
    expect(ids[1]).not.toBeNull();
    const jobs = await jobsIn(harness.database.url);
    expect(jobs).toHaveLength(1);
    // Keyed and queued by principal alone, so every project of one principal shares them.
    expect(jobs[0]?.key).toBe(`${tenant.principalId}:*:compliance_recheck`);
    expect(jobs[0]?.payload).toEqual({
      principalId: tenant.principalId,
      projectId: tenant.projectId,
    });
  });

  it('a worker with no recheck says so', () => {
    expect(unwiredTasks({})).toContain(COMPLIANCE_RECHECK.name);
    expect(
      unwiredTasks({ tenantTasks: [{ task: COMPLIANCE_RECHECK, work: () => Promise.resolve() }] }),
    ).not.toContain(COMPLIANCE_RECHECK.name);
  });
});

describe('one recheck at a time per principal', () => {
  it('rechecks for one principal never overlap, while another principal runs', async () => {
    const { held, deps } = setup();
    const first = await newTenant(harness.db);
    const second: ProjectContext = {
      principalId: first.principalId,
      projectId: await harness.db
        .tenant(first)
        .transaction(async (tx) => projects.create(tx, { name: 'Second' })),
    };
    const other = await newTenant(harness.db);
    held.set(first, UNDER);
    held.set(other, UNDER);
    const { wrapped, most, finished } = counted(complianceRecheck(deps));
    const hold = held.holdNext();
    await schedule(first);
    const worker = await start(wrapped);
    try {
      await hold.reached;
      // Several at once, from both of the principal's projects, while its first runs.
      await Promise.all([schedule(first), schedule(second), schedule(first, 'role_added')]);
      await schedule(other);
      await until('the other principal to be rechecked', async () =>
        Promise.resolve(finished.includes(other.principalId)),
      );
      // Past the pool's poll, so a job that could start has had every chance to.
      await sleep(2_500);
      expect(most.get(first.principalId)).toBe(1);
      expect(held.reads.filter((id) => id === first.principalId)).toHaveLength(1);
      hold.open();
      await until('the queue to drain', drained);
    } finally {
      hold.open();
      await worker.stop();
    }
    expect(most.get(first.principalId)).toBe(1);
    // The ones queued behind the running recheck became one more, not three.
    expect(held.reads.filter((id) => id === first.principalId)).toHaveLength(2);
  });

  it('an older reading cannot undo a newer one', async () => {
    const { held, compliance, deps } = setup();
    const tenant = await newTenant(harness.db);
    held.set(tenant, UNDER);
    const hold = held.holdNext();
    await schedule(tenant);
    const worker = await start(complianceRecheck(deps));
    try {
      // The slow recheck has read the budget under the line.
      await hold.reached;
      held.set(tenant, OVER);
      await schedule(tenant);
      await sleep(2_500);
      hold.open();
      await until('the queue to drain', drained);
    } finally {
      hold.open();
      await worker.stop();
    }
    expect(
      await compliance.read(held.keyOf(tenant), { signal: new AbortController().signal }),
    ).toMatchObject({ reason: 'principal_key_risk' });
    expect(compliance.notices.map((notice) => notice.to)).toEqual(['noncompliant']);
  });

  it('an event during a running recheck still gets a recheck of its own', async () => {
    const { held, compliance, deps } = setup();
    const tenant = await newTenant(harness.db);
    held.set(tenant, OVER);
    const hold = held.holdNext();
    await schedule(tenant);
    const worker = await start(complianceRecheck(deps));
    try {
      await hold.reached;
      // The fix lands while the first recheck runs on the reading from before it.
      held.set(tenant, UNDER);
      await schedule(tenant, 'limits_updated');
      const jobs = await jobsIn(harness.database.url);
      // The running job gave its key up, so the event did not fold into it.
      expect(jobs).toHaveLength(2);
      hold.open();
      await until('the queue to drain', drained);
    } finally {
      hold.open();
      await worker.stop();
    }
    expect(held.reads).toHaveLength(2);
    expect(
      await compliance.read(held.keyOf(tenant), { signal: new AbortController().signal }),
    ).toBeNull();
    expect(compliance.notices.map((notice) => notice.to)).toEqual(['noncompliant', 'compliant']);
  });
});

describe('when the chain cannot be read', () => {
  const failing = () => {
    const signing = createMemoryPrincipalKeyReader();
    signing.read = () => Promise.reject(new Error('rpc down'));
    return signing;
  };

  async function marked(): Promise<{ tenant: ProjectContext; context: Setup }> {
    const context = setup();
    const tenant = await newTenant(harness.db);
    context.held.set(tenant, OVER);
    await complianceRecheck(context.deps)({
      context: tenant,
      ids: {},
      tryNumber: 1,
      signal: new AbortController().signal,
    });
    return { tenant, context };
  }

  it('a failed read retries under the same key and changes nothing', async () => {
    const { tenant, context } = await marked();
    // Back under the line, but the read fails, so the mark must stay.
    context.held.set(tenant, UNDER);
    const deps = { ...context.deps, signing: failing() };
    const alerts: WorkerAlert[] = [];
    const task = tenantTask(COMPLIANCE_RECHECK, complianceRecheck(deps), {
      db: harness.db,
      alert: (fired) => alerts.push(fired),
    });
    await task({ ...tenant, try: '3' }, helpersFor('1'));

    const [job, ...others] = await jobsIn(harness.database.url);
    expect(others).toEqual([]);
    expect(job?.payload).toMatchObject({ try: '4' });
    expect(job?.key).toBe(`${tenant.principalId}:*:compliance_recheck`);
    expect(
      await context.compliance.read(context.held.keyOf(tenant), {
        signal: new AbortController().signal,
      }),
    ).not.toBeNull();
    expect(alerts).toEqual([]);
  });

  it('a recheck that keeps failing reaches the dead letter path and alerts', async () => {
    const { tenant, context } = await marked();
    const deps = { ...context.deps, signing: failing() };
    const alerts: WorkerAlert[] = [];
    const task = tenantTask(COMPLIANCE_RECHECK, complianceRecheck(deps), {
      db: harness.db,
      alert: (fired) => alerts.push(fired),
    });
    await task({ ...tenant, try: '12' }, helpersFor('77'));

    expect(await jobsIn(harness.database.url)).toEqual([]);
    const letters = await harness.db
      .tenant(tenant)
      .transaction(async (tx) => deadLetters.open(tx, { limit: 10 }));
    expect(letters.items).toHaveLength(1);
    expect(letters.items[0]).toMatchObject({
      task: COMPLIANCE_RECHECK.name,
      reason: 'COMPLIANCE_READ_FAILED',
      tries: 12,
    });
    expect(alerts).toEqual([
      {
        kind: 'dead_letter',
        task: COMPLIANCE_RECHECK.name,
        principalId: tenant.principalId,
        projectId: tenant.projectId,
        deadLetterId: letters.items[0]?.id,
        reason: 'COMPLIANCE_READ_FAILED',
      },
    ]);
  });
});
