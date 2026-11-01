// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The adapter's store in memory, holding itself to the rules the database
// store enforces with constraints: one row per network and hash, one live
// submission per network, mandate, payout and op (per mandate and op for
// administration), states that only move forward, lease fencing on executor
// accounts, and one live delivery per leg key and provider. It is what the
// fake adapter runs on until the tables exist, and the store contract tests
// prove both stores refuse the same things.
//
// Each rule can be switched off, for tests only, to show that the contract
// suite notices a store that does not enforce it.

import { InvalidInputError } from '../errors.js';
import type { NetworkId } from '../networks.js';
import type {
  AdapterStore,
  ChainAddress,
  ExecutorLease,
  LegDeliveryRecord,
  LegKey,
  PayoutId,
  SubmissionOp,
  SubmissionPatch,
  SubmissionRecord,
  SubmissionState,
  TenantScope,
  UnixSeconds,
} from '../types.js';

/** The rules a store enforces. */
export const STORE_RULES = Object.freeze([
  'unique_hash',
  'one_live_submission',
  'one_live_admin_submission',
  'starts_built',
  'forward_only',
  'tenant_scope',
  'lease_fencing',
  'one_live_delivery',
] as const);

export type StoreRule = (typeof STORE_RULES)[number];

/** States in which a submission can still land, and so blocks another. */
export const LIVE_SUBMISSION_STATES: readonly SubmissionState[] = Object.freeze([
  'built',
  'broadcast',
  'unknown',
]);

/** Every move a submission may make. Anything else is backward or sideways. */
export const SUBMISSION_TRANSITIONS: Readonly<Record<SubmissionState, readonly SubmissionState[]>> =
  Object.freeze({
    built: ['broadcast'],
    broadcast: ['landed', 'failed', 'unknown', 'expired', 'replaced'],
    unknown: ['landed', 'failed', 'expired'],
    landed: [],
    failed: [],
    expired: [],
    replaced: [],
  });

export function isLiveSubmission(state: SubmissionState): boolean {
  return LIVE_SUBMISSION_STATES.includes(state);
}

export interface FakeExecutorAccount {
  readonly address: ChainAddress;
  readonly keyId: string;
  /** The next sequence number to use. */
  readonly sequenceOrNonce: bigint;
}

export interface FakeAdapterStoreOptions {
  readonly clock: () => UnixSeconds;
  readonly executors?: readonly FakeExecutorAccount[];
  /** Test only: rules this store stops enforcing. */
  readonly unsafeDisable?: readonly StoreRule[];
}

interface ExecutorRow {
  readonly address: ChainAddress;
  readonly keyId: string;
  sequenceOrNonce: bigint;
  leaseId: string | null;
  leasedUntil: UnixSeconds | null;
}

/** One state move a store accepted, for tests that check every move was forward. */
export interface SubmissionMove {
  readonly txHash: string;
  readonly from: SubmissionState | null;
  readonly to: SubmissionState;
}

function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId;
}

function refused(issue: string): InvalidInputError {
  return new InvalidInputError({ issues: [issue] });
}

export class FakeAdapterStore implements AdapterStore {
  readonly #clock: () => UnixSeconds;
  readonly #off: ReadonlySet<StoreRule>;
  readonly #submissions: SubmissionRecord[] = [];
  readonly #executors: ExecutorRow[];
  readonly #deliveries: LegDeliveryRecord[] = [];
  readonly #moves: SubmissionMove[] = [];
  #leases = 0;

  constructor(options: FakeAdapterStoreOptions) {
    this.#clock = options.clock;
    this.#off = new Set(options.unsafeDisable ?? []);
    this.#executors = (options.executors ?? []).map((e) => ({
      address: e.address,
      keyId: e.keyId,
      sequenceOrNonce: e.sequenceOrNonce,
      leaseId: null,
      leasedUntil: null,
    }));
  }

  /** Every state move accepted so far, the first recording included. */
  get moves(): readonly SubmissionMove[] {
    return this.#moves;
  }

  /** Every submission row, for assertions. */
  get submissions(): readonly SubmissionRecord[] {
    return this.#submissions;
  }

  #on(rule: StoreRule): boolean {
    return !this.#off.has(rule);
  }

  recordSubmission(s: SubmissionRecord): Promise<void> {
    if (this.#on('starts_built') && s.state !== 'built') {
      return Promise.reject(refused('submission.state (not_built)'));
    }
    if (
      this.#on('unique_hash') &&
      this.#submissions.some((r) => r.network === s.network && r.txHash === s.txHash)
    ) {
      return Promise.reject(refused('submission.txHash (duplicate)'));
    }
    if (isLiveSubmission(s.state) && s.mandate !== null) {
      const clash = this.#submissions.find(
        (r) =>
          isLiveSubmission(r.state) &&
          r.network === s.network &&
          r.mandate === s.mandate &&
          r.op === s.op &&
          r.payoutId === s.payoutId,
      );
      const rule: StoreRule =
        s.payoutId === null ? 'one_live_admin_submission' : 'one_live_submission';
      if (clash !== undefined && this.#on(rule)) {
        return Promise.reject(refused('submission (live_exists)'));
      }
    }
    this.#submissions.push(Object.freeze({ ...s }));
    this.#moves.push({ txHash: s.txHash, from: null, to: s.state });
    return Promise.resolve();
  }

  updateSubmission(
    scope: TenantScope,
    network: NetworkId,
    txHash: string,
    patch: SubmissionPatch,
  ): Promise<void> {
    const at = this.#submissions.findIndex(
      (r) =>
        r.network === network &&
        r.txHash === txHash &&
        (!this.#on('tenant_scope') || sameScope(r.scope, scope)),
    );
    const row = this.#submissions[at];
    if (row === undefined) return Promise.reject(refused('submission (not_found)'));
    const next = patch.state ?? row.state;
    if (
      this.#on('forward_only') &&
      next !== row.state &&
      !SUBMISSION_TRANSITIONS[row.state].includes(next)
    ) {
      return Promise.reject(refused('submission.state (backward)'));
    }
    this.#submissions[at] = Object.freeze({ ...row, ...patch });
    if (next !== row.state) this.#moves.push({ txHash, from: row.state, to: next });
    return Promise.resolve();
  }

  liveSubmission(key: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    readonly mandate: string;
    readonly payoutId: PayoutId;
    readonly op: SubmissionOp;
  }): Promise<SubmissionRecord | null> {
    const found = this.#submissions.find(
      (r) =>
        isLiveSubmission(r.state) &&
        (!this.#on('tenant_scope') || sameScope(r.scope, key.scope)) &&
        r.network === key.network &&
        r.mandate === key.mandate &&
        r.payoutId === key.payoutId &&
        r.op === key.op,
    );
    return Promise.resolve(found ?? null);
  }

  unresolvedSubmissions(
    network: NetworkId,
    olderThanSeconds: number,
    limit: number,
  ): Promise<readonly SubmissionRecord[]> {
    const cutoff = this.#clock() - BigInt(olderThanSeconds);
    return Promise.resolve(
      this.#submissions
        .filter((r) => r.network === network && isLiveSubmission(r.state) && r.createdAt <= cutoff)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .slice(0, limit),
    );
  }

  leaseExecutor(network: NetworkId, leaseSeconds: number): Promise<ExecutorLease> {
    const now = this.#clock();
    const free = this.#executors.find(
      (e) =>
        e.address.network === network &&
        (e.leaseId === null || e.leasedUntil === null || e.leasedUntil <= now),
    );
    if (free === undefined) return Promise.reject(refused('executor (none_free)'));
    this.#leases += 1;
    free.leaseId = `lease-${String(this.#leases)}`;
    free.leasedUntil = (now + BigInt(leaseSeconds)) as UnixSeconds;
    return Promise.resolve(
      Object.freeze({
        network,
        address: free.address,
        keyId: free.keyId,
        sequenceOrNonce: free.sequenceOrNonce,
        leaseId: free.leaseId,
        expiresAt: free.leasedUntil,
      }),
    );
  }

  releaseExecutor(lease: ExecutorLease, next: { readonly sequenceOrNonce: bigint }): Promise<void> {
    const row = this.#executors.find(
      (e) => e.address.network === lease.network && e.address.value === lease.address.value,
    );
    if (row === undefined) return Promise.reject(refused('lease (not_found)'));
    if (this.#on('lease_fencing') && row.leaseId !== lease.leaseId) {
      return Promise.reject(refused('lease.leaseId (stale)'));
    }
    if (next.sequenceOrNonce < row.sequenceOrNonce) {
      return Promise.reject(refused('next.sequenceOrNonce (backward)'));
    }
    row.sequenceOrNonce = next.sequenceOrNonce;
    row.leaseId = null;
    row.leasedUntil = null;
    return Promise.resolve();
  }

  upsertDelivery(d: LegDeliveryRecord): Promise<void> {
    const at = this.#deliveries.findIndex(
      (r) => r.legKey === d.legKey && r.provider === d.provider && r.providerRef === d.providerRef,
    );
    const existing = this.#deliveries[at];
    if (existing !== undefined && this.#on('tenant_scope') && !sameScope(existing.scope, d.scope)) {
      return Promise.reject(refused('delivery (not_found)'));
    }
    if (
      d.live &&
      this.#on('one_live_delivery') &&
      this.#deliveries.some(
        (r, i) => i !== at && r.live && r.legKey === d.legKey && r.provider === d.provider,
      )
    ) {
      return Promise.reject(refused('delivery (live_exists)'));
    }
    const row = Object.freeze({ ...d });
    if (existing === undefined) this.#deliveries.push(row);
    else this.#deliveries[at] = row;
    return Promise.resolve();
  }

  liveDelivery(scope: TenantScope, legKey: LegKey): Promise<LegDeliveryRecord | null> {
    const live = this.#deliveries.filter(
      (r) =>
        r.live && r.legKey === legKey && (!this.#on('tenant_scope') || sameScope(r.scope, scope)),
    );
    // Several providers can each hold a live record; the latest is current.
    const latest = live.reduce<LegDeliveryRecord | null>(
      (best, r) => (best === null || r.updatedAt >= best.updatedAt ? r : best),
      null,
    );
    return Promise.resolve(latest);
  }
}
