// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The contract cannot price in USD, so a principal can raise a budget past
// 50,000 USD by calling the contract directly, around the creation gate. When
// that happens UJIRA stops serving the mandate until it complies again. The
// contract's own guarantees are untouched, and agents can still call it
// themselves; this only decides what UJIRA's own router and executor do.

import type { Uuid } from '@ujira/chain-adapter';

import { PRINCIPAL_KEY_FIXES } from './errors.js';
import type { PrincipalKeyFix } from './errors.js';
import { callPort } from './ports.js';
import type { PortCallOptions } from './ports.js';
import { evaluateInstances } from './principal-key.js';
import type { PrincipalKeyDeps } from './principal-key.js';

/** The mandate events that can change the answer, the principal transfer included. */
export const WATCHED_MANDATE_EVENTS: ReadonlySet<string> = new Set([
  'limits_updated',
  'role_added',
  'role_removed',
  'recovery_threshold_set',
  'principal_transferred',
]);

/** What a parked job's status says. Not failed, and not retried in a loop. */
export const BLOCKED_BY_POLICY = 'blocked_by_policy';

export interface InstanceKey {
  readonly principalId: Uuid;
  readonly projectId: Uuid;
  readonly instanceId: string;
}

export interface NoncompliantMark {
  readonly reason: 'principal_key_risk';
  readonly since: Date;
}

/** What the principal is told when a mandate's state changes. */
export interface ComplianceNotice {
  readonly key: InstanceKey;
  readonly to: 'noncompliant' | 'compliant';
  readonly at: Date;
  /** The exact ways back, when noncompliant. */
  readonly fixes: readonly PrincipalKeyFix[];
}

export interface ComplianceStore {
  read(key: InstanceKey, opts: PortCallOptions): Promise<NoncompliantMark | null>;
  /**
   * In one transaction: sets or clears the mark and, only if that changed
   * anything, enqueues the notice and, on a clear, resumes the parked jobs.
   * Returns whether it changed anything. Together they make a replayed event
   * a no op, and a crash cannot leave a mark without its notice.
   */
  applyMark(
    key: InstanceKey,
    mark: NoncompliantMark | null,
    notice: ComplianceNotice,
    opts: PortCallOptions,
  ): Promise<boolean>;
  /**
   * In one transaction with the mark: parks the job if the instance is
   * marked and says so. Checking and parking apart could park a job just
   * after the mark cleared, with nothing left to resume it.
   */
  parkIfNoncompliant(key: InstanceKey, jobId: string, opts: PortCallOptions): Promise<boolean>;
}

export interface ComplianceDeps extends PrincipalKeyDeps {
  readonly compliance: ComplianceStore;
  readonly now?: () => Date;
}

/**
 * Re-runs the principal key rule over everything the principal holds and
 * moves each instance to the state it belongs in. All of them, not just the
 * one that changed: the budget is summed across the principal's holdings, so
 * one increase can put another mandate out of compliance. Returns the
 * notices for what changed. A failed chain read throws and changes nothing,
 * so the indexer's job can retry it; a mark never clears on an outage.
 */
export async function recheckPrincipal(
  principalId: Uuid,
  deps: ComplianceDeps,
): Promise<readonly ComplianceNotice[]> {
  const instances = await callPort(
    (opts) => deps.instances.list(principalId, opts),
    deps.timeoutMs,
  );
  const verdict = await evaluateInstances(principalId, instances, deps);
  const failing = new Set(verdict.aboveLimit ? verdict.unqualified : []);
  const at = (deps.now ?? (() => new Date()))();
  const changes: ComplianceNotice[] = [];
  for (const { instanceId, projectId } of instances) {
    const key: InstanceKey = { principalId, projectId, instanceId };
    const noncompliant = failing.has(instanceId);
    const notice: ComplianceNotice = Object.freeze({
      key,
      to: noncompliant ? 'noncompliant' : 'compliant',
      at,
      fixes: noncompliant ? PRINCIPAL_KEY_FIXES : Object.freeze([]),
    });
    const mark: NoncompliantMark | null = noncompliant
      ? { reason: 'principal_key_risk', since: at }
      : null;
    const changed = await callPort(
      (opts) => deps.compliance.applyMark(key, mark, notice, opts),
      deps.timeoutMs,
    );
    if (changed) changes.push(notice);
  }
  return Object.freeze(changes);
}

/** Called by the indexer for each mandate event. Other events change nothing. */
export async function onMandateEvent(
  principalId: Uuid,
  eventName: string,
  deps: ComplianceDeps,
): Promise<readonly ComplianceNotice[]> {
  if (!WATCHED_MANDATE_EVENTS.has(eventName)) return Object.freeze([]);
  return recheckPrincipal(principalId, deps);
}

/**
 * The router's check: the candidates it may select for a new payout. A store
 * that cannot answer throws, so an outage selects nothing rather than
 * everything.
 */
export async function servableInstances<T extends { readonly key: InstanceKey }>(
  candidates: readonly T[],
  deps: Pick<ComplianceDeps, 'compliance' | 'timeoutMs'>,
): Promise<readonly T[]> {
  const servable: T[] = [];
  for (const candidate of candidates) {
    const mark = await callPort(
      (opts) => deps.compliance.read(candidate.key, opts),
      deps.timeoutMs,
    );
    if (mark === null) servable.push(candidate);
  }
  return Object.freeze(servable);
}

export type SubmissionDecision =
  | { readonly action: 'submit' }
  | { readonly action: 'park'; readonly status: typeof BLOCKED_BY_POLICY };

/**
 * The executor's check before it submits execute or execute_batch, and the
 * payouts worker's for a queued job. A failure throws and nothing is
 * submitted, so the worker's bounded retry applies.
 */
export async function guardSubmission(
  key: InstanceKey,
  jobId: string,
  deps: Pick<ComplianceDeps, 'compliance' | 'timeoutMs'>,
): Promise<SubmissionDecision> {
  const parked = await callPort(
    (opts) => deps.compliance.parkIfNoncompliant(key, jobId, opts),
    deps.timeoutMs,
  );
  return parked ? { action: 'park', status: BLOCKED_BY_POLICY } : { action: 'submit' };
}

export interface MemoryComplianceStore extends ComplianceStore {
  /** Every notice enqueued, in order. */
  readonly notices: readonly ComplianceNotice[];
  /** Jobs resumed so far, in order. */
  readonly resumed: readonly string[];
  /** Jobs parked now, for one instance. */
  parked(key: InstanceKey): readonly string[];
}

export function createMemoryComplianceStore(): MemoryComplianceStore {
  const marks = new Map<string, NoncompliantMark>();
  const parked = new Map<string, Set<string>>();
  const notices: ComplianceNotice[] = [];
  const resumed: string[] = [];
  const keyOf = (key: InstanceKey): string =>
    JSON.stringify([key.principalId, key.projectId, key.instanceId]);
  return {
    notices,
    resumed,
    read(key) {
      return Promise.resolve(marks.get(keyOf(key)) ?? null);
    },
    applyMark(key, mark, notice) {
      const id = keyOf(key);
      if (marks.has(id) === (mark !== null)) return Promise.resolve(false);
      if (mark === null) {
        marks.delete(id);
        resumed.push(...(parked.get(id) ?? []));
        parked.delete(id);
      } else {
        marks.set(id, mark);
      }
      notices.push(notice);
      return Promise.resolve(true);
    },
    parkIfNoncompliant(key, jobId) {
      const id = keyOf(key);
      if (!marks.has(id)) return Promise.resolve(false);
      parked.set(id, (parked.get(id) ?? new Set<string>()).add(jobId));
      return Promise.resolve(true);
    },
    parked(key) {
      return [...(parked.get(keyOf(key)) ?? [])];
    },
  };
}
