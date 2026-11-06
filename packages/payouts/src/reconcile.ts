// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compares every mandate instance's ledger mirror with its contract. The contract is
// the authority: each run reads state() and sets its spent, pending, committed and
// balance beside the books. A match records when; a mismatch marks the instance and
// raises one alert for the episode, so drift is found before a principal notices.
//
// It never corrects money. A disagreement can come from a missed event, a reorg or a
// bug, and only a person can tell which, so the books are left exactly as they are.

import { isNetworkId } from '@ujira/chain-adapter';
import type { ChainAdapter, MandateRef, NetworkId, TenantScope } from '@ujira/chain-adapter';
import { z } from 'zod';

export const RECONCILE_SWEEP_TASK = 'reconcile:sweep';
export const RECONCILE_TASK = 'mandate:reconcile';

const CALL_DEADLINE_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;

/** One comparison per instance at a time, however many sweeps or restores ask. */
export function reconcileJobKey(instanceId: string): string {
  return `mandate:${instanceId}:reconcile`;
}

const payloadSchema = z.strictObject({
  principalId: z.guid(),
  projectId: z.guid(),
  instanceId: z.guid(),
  network: z.string().refine(isNetworkId),
  mandate: z.string().min(1).max(128),
});

export interface ReconcilePayload {
  readonly principalId: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly network: string;
  /** The mandate's address on that network. */
  readonly mandate: string;
}

/** A payload the job cannot read. It names the fields, never what they held. */
export class ReconcilePayloadError extends Error {
  override readonly name = 'ReconcilePayloadError';
  readonly code = 'RECONCILE_PAYLOAD_INVALID';
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`the reconcile payload is invalid: ${issues.join(', ')}`);
    this.issues = issues;
  }
}

/** The four figures the contract reports, in raw units, at a ledger. */
export interface ReconcileFigures {
  readonly ledger: bigint;
  readonly balance: bigint;
  readonly pending: bigint;
  readonly committed: bigint;
  readonly spent: bigint;
}

/** The outcome as the store recorded it on the instance. */
export interface ReconcileRecord {
  readonly matches: boolean;
  readonly ledger: bigint;
  readonly state: ReconcileFigures;
  readonly books: ReconcileFigures;
  readonly lastReconciledAt: Date | null;
  readonly divergedSince: Date | null;
  /** True only on the comparison that found them apart after they last agreed. */
  readonly newlyDiverged: boolean;
}

interface StoreOptions {
  readonly signal: AbortSignal;
}

export interface ReconcileStore {
  /** Stores state(), compares it with the books and records the outcome, in one transaction. */
  record(
    scope: TenantScope,
    instanceId: string,
    state: ReconcileFigures,
    opts: StoreOptions,
  ): Promise<ReconcileRecord>;
}

export interface DivergenceAlert {
  readonly scope: TenantScope;
  readonly instanceId: string;
  readonly mandate: MandateRef;
  readonly ledger: bigint;
  readonly state: ReconcileFigures;
  readonly books: ReconcileFigures;
}

export interface ReconcileAlerts {
  divergence(alert: DivergenceAlert): Promise<void>;
}

export interface ReconcileDeps {
  /** Reads only. Nothing here can send anything. */
  readonly adapter: Pick<ChainAdapter, 'readMandate'>;
  readonly store: ReconcileStore;
  readonly alerts: ReconcileAlerts;
  readonly timeoutMs?: number;
}

export type ReconcileOutcome =
  | { readonly kind: 'matched'; readonly ledger: bigint }
  | { readonly kind: 'diverged'; readonly ledger: bigint; readonly alerted: boolean };

function parsePayload(raw: unknown): ReconcilePayload {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) =>
      issue.path.length === 0 ? '(payload)' : issue.path.join('.'),
    );
    throw new ReconcilePayloadError([...new Set(issues)]);
  }
  return parsed.data;
}

/** One run of `mandate:reconcile`. A failed read or write throws, typed, for the queue. */
export async function runReconcile(raw: unknown, deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const payload = parsePayload(raw);
  const scope = { principalId: payload.principalId, projectId: payload.projectId } as TenantScope;
  const network = payload.network as NetworkId;
  const mandate: MandateRef = {
    network,
    address: { network, value: payload.mandate },
    specVersion: 1,
  };
  const signal = AbortSignal.timeout(deps.timeoutMs ?? CALL_DEADLINE_MS);
  const snapshot = await deps.adapter.readMandate(
    { scope, mandate },
    { signal, correlationId: reconcileJobKey(payload.instanceId) },
  );
  const { state } = snapshot;
  const figures: ReconcileFigures = {
    ledger: snapshot.observedAt.ledgerOrBlock,
    balance: state.balance.amount,
    pending: state.pending.amount,
    committed: state.committed.amount,
    spent: state.spent.amount,
  };
  const recorded = await deps.store.record(scope, payload.instanceId, figures, { signal });
  if (recorded.matches) return { kind: 'matched', ledger: recorded.ledger };
  if (recorded.newlyDiverged) {
    await deps.alerts.divergence({
      scope,
      instanceId: payload.instanceId,
      mandate,
      ledger: recorded.ledger,
      state: recorded.state,
      books: recorded.books,
    });
  }
  return { kind: 'diverged', ledger: recorded.ledger, alerted: recorded.newlyDiverged };
}

// ---------------------------------------------------------------------------
// Finding the instances

/** An instance to compare, with the tenant to compare it under. */
export interface ReconcileTarget {
  readonly scope: TenantScope;
  readonly instanceId: string;
  readonly network: string;
  readonly mandate: string;
}

export interface ReconcileTargets {
  /** A page of targets after `after`, in a stable order, and the key of the next page. */
  page(
    after: string | null,
    limit: number,
  ): Promise<{ readonly items: readonly ReconcileTarget[]; readonly next: string | null }>;
}

export interface ReconcileJob {
  readonly task: typeof RECONCILE_TASK;
  readonly jobKey: string;
  /** The job is added inside this tenant's own transaction. */
  readonly scope: TenantScope;
  readonly payload: ReconcilePayload;
}

function payloadOf(target: ReconcileTarget): ReconcilePayload {
  return {
    principalId: target.scope.principalId,
    projectId: target.scope.projectId,
    instanceId: target.instanceId,
    network: target.network,
    mandate: target.mandate,
  };
}

async function eachTarget(
  targets: ReconcileTargets,
  pageSize: number,
  visit: (target: ReconcileTarget) => Promise<void>,
): Promise<number> {
  let after: string | null = null;
  let count = 0;
  for (;;) {
    const page = await targets.page(after, pageSize);
    for (const target of page.items) {
      await visit(target);
      count += 1;
    }
    if (page.next === null) return count;
    after = page.next;
  }
}

/** One run of `reconcile:sweep`: a job for every instance. Returns how many. */
export function runReconcileSweep(
  deps: {
    readonly targets: ReconcileTargets;
    readonly enqueue: (job: ReconcileJob) => Promise<void>;
  },
  options: { readonly pageSize?: number } = {},
): Promise<number> {
  return eachTarget(deps.targets, options.pageSize ?? DEFAULT_PAGE_SIZE, (target) =>
    deps.enqueue({
      task: RECONCILE_TASK,
      jobKey: reconcileJobKey(target.instanceId),
      scope: target.scope,
      payload: payloadOf(target),
    }),
  );
}

export interface RestoreCheck {
  /** True only when every instance agrees with its contract. */
  readonly ready: boolean;
  readonly checked: number;
  readonly diverged: readonly string[];
}

/**
 * After a restore, compares every instance before traffic is let in, and says
 * whether it may be. The books are only ever reported on, never changed.
 */
export async function reconcileBeforeTraffic(
  deps: {
    readonly targets: ReconcileTargets;
    readonly run: (payload: ReconcilePayload) => Promise<ReconcileOutcome>;
  },
  options: { readonly pageSize?: number } = {},
): Promise<RestoreCheck> {
  const diverged: string[] = [];
  const checked = await eachTarget(
    deps.targets,
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    async (target) => {
      const outcome = await deps.run(payloadOf(target));
      if (outcome.kind === 'diverged') diverged.push(target.instanceId);
    },
  );
  return { ready: diverged.length === 0, checked, diverged };
}
