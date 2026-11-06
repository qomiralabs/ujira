// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for reconciling mandate instances against the chain (reconcile.ts).
 *
 * - The contract is the authority. Each run reads state() and compares its spent,
 *   pending, committed and balance with the books; a match records when, and a
 *   mismatch marks the instance and raises one divergence alert per episode.
 * - It never corrects money: it reports and leaves the books as they are.
 * - The sweep pages every instance to compare and enqueues one job per instance,
 *   under that instance's tenant; after a restore it runs them all before traffic.
 */

import { describe, expect, it } from 'vitest';

import type { TenantScope } from '@ujira/chain-adapter';
import { deployMandate, fakeAdapterHarness } from '@ujira/chain-adapter/testing';

import {
  RECONCILE_SWEEP_TASK,
  RECONCILE_TASK,
  ReconcilePayloadError,
  reconcileBeforeTraffic,
  reconcileJobKey,
  runReconcile,
  runReconcileSweep,
} from './index.js';
import type {
  ReconcileDeps,
  ReconcileFigures,
  ReconcileJob,
  ReconcilePayload,
  ReconcileRecord,
  ReconcileStore,
  ReconcileTarget,
} from './index.js';

const FUNDS = 10_000_000n;
const INSTANCE = '5b0e7c4e-2a59-4d1e-8f37-6c0a9b1d2e3f';

/** The books per instance, and the outcome rows a database version must match. */
function memoryStore(books: Map<string, ReconcileFigures>) {
  const rows = new Map<string, ReconcileRecord>();
  const posted: string[] = [];
  const store: ReconcileStore = {
    record: (scope: TenantScope, instanceId: string, state: ReconcileFigures) => {
      const key = `${scope.principalId}/${scope.projectId}/${instanceId}`;
      const mine = books.get(key) ?? {
        ledger: 0n,
        balance: 0n,
        pending: 0n,
        committed: 0n,
        spent: 0n,
      };
      const matches =
        mine.balance === state.balance &&
        mine.pending === state.pending &&
        mine.committed === state.committed &&
        mine.spent === state.spent;
      const before = rows.get(key);
      const at = new Date(1_800_000_000_000 + rows.size);
      const row: ReconcileRecord = {
        matches,
        ledger: state.ledger,
        state,
        books: { ...mine, ledger: state.ledger },
        lastReconciledAt: matches ? at : (before?.lastReconciledAt ?? null),
        divergedSince: matches ? null : (before?.divergedSince ?? at),
        newlyDiverged: !matches && (before === undefined || before.matches),
      };
      rows.set(key, row);
      return Promise.resolve(row);
    },
  };
  return { store, rows, posted };
}

async function setup() {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h, { fund: FUNDS });
  const key = `${h.scope.principalId}/${h.scope.projectId}/${INSTANCE}`;
  const books = new Map<string, ReconcileFigures>();
  const memory = memoryStore(books);
  const alerts: Parameters<ReconcileDeps['alerts']['divergence']>[0][] = [];
  const deps: ReconcileDeps = {
    adapter: h.adapter,
    store: memory.store,
    alerts: {
      divergence: (alert) => {
        alerts.push(alert);
        return Promise.resolve();
      },
    },
  };
  const payload = (scope: TenantScope = h.scope): ReconcilePayload => ({
    principalId: scope.principalId,
    projectId: scope.projectId,
    instanceId: INSTANCE,
    network: h.adapter.network,
    mandate: m.ref.address.value,
  });
  const booksAre = (balance: bigint) =>
    books.set(key, { ledger: 0n, balance, pending: 0n, committed: 0n, spent: 0n });
  return { h, m, deps, payload, booksAre, alerts, ...memory, key };
}

describe('reconciling one instance', () => {
  it('is keyed once per instance', () => {
    expect(RECONCILE_TASK).toBe('mandate:reconcile');
    expect(RECONCILE_SWEEP_TASK).toBe('reconcile:sweep');
    expect(reconcileJobKey(INSTANCE)).toBe(`mandate:${INSTANCE}:reconcile`);
  });

  it('matching state records last_reconciled_at', async () => {
    const w = await setup();
    w.booksAre(FUNDS);
    const outcome = await runReconcile(w.payload(), w.deps);
    expect(outcome).toMatchObject({ kind: 'matched' });
    const row = w.rows.get(w.key);
    expect(row?.matches).toBe(true);
    expect(row?.lastReconciledAt).toBeInstanceOf(Date);
    expect(row?.state).toMatchObject({ balance: FUNDS, pending: 0n, committed: 0n, spent: 0n });
    expect(w.alerts).toEqual([]);
  });

  it('fake state mismatch raises divergence', async () => {
    const w = await setup();
    // The books are short by one unit of what the contract holds.
    w.booksAre(FUNDS - 1n);
    const outcome = await runReconcile(w.payload(), w.deps);
    expect(outcome).toMatchObject({ kind: 'diverged', alerted: true });
    expect(w.rows.get(w.key)?.divergedSince).toBeInstanceOf(Date);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toMatchObject({
      scope: w.h.scope,
      instanceId: INSTANCE,
      mandate: w.m.ref,
      state: { balance: FUNDS },
      books: { balance: FUNDS - 1n },
    });
    // Still apart on the next run: marked, and not alerted again.
    expect(await runReconcile(w.payload(), w.deps)).toMatchObject({
      kind: 'diverged',
      alerted: false,
    });
    expect(w.alerts).toHaveLength(1);
    // Back together, the mark clears; apart again, a new alert.
    w.booksAre(FUNDS);
    expect((await runReconcile(w.payload(), w.deps)).kind).toBe('matched');
    expect(w.rows.get(w.key)?.divergedSince).toBeNull();
    w.booksAre(FUNDS + 1n);
    await runReconcile(w.payload(), w.deps);
    expect(w.alerts).toHaveLength(2);
  });

  it('never moves money to make them agree', async () => {
    const w = await setup();
    w.booksAre(0n);
    const sent = w.h.moves().length;
    const balance = await w.h.balance(w.m.ref.address);
    await runReconcile(w.payload(), w.deps);
    expect(w.h.moves()).toHaveLength(sent);
    expect(await w.h.balance(w.m.ref.address)).toBe(balance);
  });

  it('reads only the tenant in its payload', async () => {
    const w = await setup();
    const error = await runReconcile(w.payload(w.h.otherScope), w.deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(w.rows.size).toBe(0);
  });

  it('refuses a payload it cannot read, naming the field and never its value', async () => {
    const w = await setup();
    for (const raw of [null, { ...w.payload(), instanceId: 'nope' }, { ...w.payload(), x: 1 }]) {
      const error = await runReconcile(raw, w.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReconcilePayloadError);
      expect((error as Error).message).not.toContain('nope');
    }
  });
});

describe('the reconcile sweep', () => {
  const scope = (n: number): TenantScope =>
    ({
      principalId: `0000000${String(n)}-0000-4000-8000-000000000000`,
      projectId: `1000000${String(n)}-0000-4000-8000-000000000000`,
    }) as TenantScope;
  const target = (n: number): ReconcileTarget => ({
    scope: scope(n % 3),
    instanceId: `2000000${String(n)}-0000-4000-8000-000000000000`,
    network: 'stellar:testnet',
    mandate: `C${String(n)}`,
  });
  const all = Array.from({ length: 7 }, (_, i) => target(i));
  const pages = {
    page: (after: string | null, limit: number) => {
      const start = after === null ? 0 : all.findIndex((t) => t.instanceId === after) + 1;
      const items = all.slice(start, start + limit);
      const last = items.at(-1);
      return Promise.resolve({
        items,
        next: start + limit < all.length && last !== undefined ? last.instanceId : null,
      });
    },
  };

  it('pages every instance and enqueues one job each, under its own tenant', async () => {
    const jobs: ReconcileJob[] = [];
    const count = await runReconcileSweep(
      {
        targets: pages,
        enqueue: (job) => {
          jobs.push(job);
          return Promise.resolve();
        },
      },
      { pageSize: 3 },
    );
    expect(count).toBe(7);
    expect(jobs.map((j) => j.jobKey)).toEqual(all.map((t) => reconcileJobKey(t.instanceId)));
    for (const [i, job] of jobs.entries()) {
      const t = all[i];
      expect(job.task).toBe(RECONCILE_TASK);
      expect(job.scope).toEqual(t?.scope);
      expect(job.payload).toEqual({
        principalId: t?.scope.principalId,
        projectId: t?.scope.projectId,
        instanceId: t?.instanceId,
        network: 'stellar:testnet',
        mandate: t?.mandate,
      });
    }
  });

  it('after a restore, runs every instance and admits traffic only when all agree', async () => {
    const seen: string[] = [];
    const ok = await reconcileBeforeTraffic(
      {
        targets: pages,
        run: (payload) => {
          seen.push(payload.instanceId);
          return Promise.resolve(
            payload.mandate === 'C4'
              ? { kind: 'diverged' as const, ledger: 1n, alerted: true }
              : { kind: 'matched' as const, ledger: 1n },
          );
        },
      },
      { pageSize: 2 },
    );
    expect(seen).toHaveLength(7);
    expect(ok).toEqual({ ready: false, checked: 7, diverged: [all[4]?.instanceId] });
  });
});
