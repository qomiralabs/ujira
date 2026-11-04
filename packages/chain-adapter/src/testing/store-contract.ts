// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The contract every adapter store meets: the in-memory one here and the
// database one in the db package. Each check names the rules it relies on,
// so a test can switch one rule off in the fake and prove that some check
// notices. A store that passes every check refuses what the tables refuse.

import { describe, expect, it } from 'vitest';

import { ChainAdapterError } from '../errors.js';
import type { NetworkId } from '../networks.js';
import type {
  AdapterStore,
  LegDeliveryRecord,
  LegKey,
  PayoutId,
  SubmissionRecord,
  SubmissionState,
  TenantScope,
  UnixSeconds,
} from '../types.js';

import { accountFromSeed, contractAddress } from './address.js';
import { hexOf, sha256, utf8 } from './bytes.js';
import { STORE_RULES, SUBMISSION_TRANSITIONS } from './fake-store.js';
import type { StoreRule } from './fake-store.js';

export interface StoreHarness {
  readonly store: AdapterStore;
  readonly network: NetworkId;
  /** Another network the store accepts, for checks that rows on two networks never clash. */
  readonly otherNetwork: NetworkId;
  readonly scope: TenantScope;
  readonly otherScope: TenantScope;
  /** Executor accounts in the pool on `network`; at least two. */
  readonly executors: number;
  now(): UnixSeconds;
  advance(seconds: bigint): Promise<void>;
}

export type StoreHarnessFactory = () => StoreHarness | Promise<StoreHarness>;

export interface StoreCheck {
  readonly name: string;
  /** The rules this check fails without. */
  readonly rules: readonly StoreRule[];
  run(h: StoreHarness): Promise<void>;
}

export interface StoreCheckResult {
  readonly name: string;
  readonly rules: readonly StoreRule[];
  readonly passed: boolean;
}

const STATES: readonly SubmissionState[] = Object.keys(SUBMISSION_TRANSITIONS) as SubmissionState[];

// How to reach each state from built through allowed moves only.
const PATH: Readonly<Record<SubmissionState, readonly SubmissionState[]>> = {
  built: [],
  broadcast: ['broadcast'],
  unknown: ['broadcast', 'unknown'],
  landed: ['broadcast', 'landed'],
  failed: ['broadcast', 'failed'],
  expired: ['broadcast', 'expired'],
  replaced: ['broadcast', 'replaced'],
};

const MANDATE = contractAddress(sha256(utf8('store-contract:mandate')));
const OTHER_MANDATE = contractAddress(sha256(utf8('store-contract:other-mandate')));
const SIGNER = accountFromSeed(sha256(utf8('store-contract:signer')));

function bytes32(label: string): string {
  return hexOf(sha256(utf8(`store-contract:${label}`)));
}

function hash(label: string): string {
  return bytes32(label).slice(2);
}

function payout(label: string): PayoutId {
  return bytes32(`payout:${label}`) as PayoutId;
}

function submission(
  h: StoreHarness,
  label: string,
  o: Partial<SubmissionRecord> = {},
): SubmissionRecord {
  return {
    scope: h.scope,
    network: h.network,
    txHash: hash(`tx:${label}`),
    op: 'request',
    mandate: MANDATE,
    payoutId: payout(label),
    attempt: 1,
    signerAddress: SIGNER,
    sequenceOrNonce: 1n,
    maxTime: null,
    state: 'built',
    landedAtHeight: null,
    errorCode: null,
    specCode: null,
    replacesTxHash: null,
    submittedAtLedger: null,
    reservationId: null,
    correlationId: `corr-${label}`,
    createdAt: h.now(),
    ...o,
  };
}

function delivery(
  h: StoreHarness,
  label: string,
  o: Partial<LegDeliveryRecord> = {},
): LegDeliveryRecord {
  return {
    scope: h.scope,
    legKey: `${payout(label)}00` as LegKey,
    network: h.network,
    rail: 'stellar.sep31',
    provider: 'anchor-a',
    providerRef: `ref-${label}`,
    destination: { address: { network: h.network, value: SIGNER }, tag: 7n },
    quoteId: null,
    state: 'in_transit',
    rawStatus: null,
    live: true,
    expiresAt: null,
    updatedAt: h.now(),
    ...o,
  };
}

// A refusal must be one of the adapter's typed errors, never a driver's.
async function refused(promise: Promise<unknown>): Promise<boolean> {
  return promise.then(
    () => false,
    (error: unknown) => {
      expect(error).toBeInstanceOf(ChainAdapterError);
      return true;
    },
  );
}

async function walk(h: StoreHarness, r: SubmissionRecord, to: SubmissionState): Promise<void> {
  for (const state of PATH[to])
    await h.store.updateSubmission(r.scope, r.network, r.txHash, { state });
}

// Every record these checks read back names a mandate and a payout.
async function live(h: StoreHarness, r: SubmissionRecord): Promise<SubmissionRecord | null> {
  return h.store.liveSubmission({
    scope: r.scope,
    network: r.network,
    mandate: String(r.mandate),
    payoutId: r.payoutId as unknown as PayoutId,
    op: r.op,
  });
}

/** Every check, in the order the suite runs them. */
export const STORE_CHECKS: readonly StoreCheck[] = Object.freeze([
  {
    name: 'records a submission and finds it live, for its own tenant only',
    rules: ['tenant_scope'],
    async run(h) {
      const r = submission(h, 'live');
      await h.store.recordSubmission(r);
      expect(await live(h, r)).toEqual(r);
      expect(await live(h, { ...r, scope: h.otherScope })).toBe(null);
    },
  },
  {
    name: 'refuses a second row with the same network and hash, from any tenant',
    rules: ['unique_hash'],
    async run(h) {
      const r = submission(h, 'hash');
      await h.store.recordSubmission(r);
      const again = { ...r, scope: h.otherScope, payoutId: payout('hash-2') };
      expect(await refused(h.store.recordSubmission(again))).toBe(true);
      await h.store.recordSubmission({ ...r, network: h.otherNetwork });
    },
  },
  {
    name: 'keeps one live submission per network, mandate, payout id and op',
    rules: ['one_live_submission'],
    async run(h) {
      const r = submission(h, 'one-live');
      await h.store.recordSubmission(r);
      const second = { ...r, txHash: hash('one-live-2') };
      expect(await refused(h.store.recordSubmission(second))).toBe(true);
      await h.store.recordSubmission({ ...second, txHash: hash('one-live-3'), op: 'execute' });
      await h.store.recordSubmission({
        ...second,
        txHash: hash('one-live-4'),
        network: h.otherNetwork,
      });
      await h.store.recordSubmission({
        ...second,
        txHash: hash('one-live-5'),
        mandate: OTHER_MANDATE,
      });
      await walk(h, r, 'landed');
      await h.store.recordSubmission({ ...second, txHash: hash('one-live-6') });
    },
  },
  {
    name: 'keeps one live administration submission per network, mandate and op',
    rules: ['one_live_admin_submission'],
    async run(h) {
      const r = submission(h, 'admin', { op: 'pause', payoutId: null, attempt: null });
      await h.store.recordSubmission(r);
      const second = { ...r, txHash: hash('admin-2') };
      expect(await refused(h.store.recordSubmission(second))).toBe(true);
      await h.store.recordSubmission({ ...second, txHash: hash('admin-3'), op: 'resume' });
      await walk(h, r, 'failed');
      await h.store.recordSubmission({ ...second, txHash: hash('admin-4') });
    },
  },
  {
    name: 'records a submission only as built, before broadcast',
    rules: ['starts_built'],
    async run(h) {
      for (const state of STATES.filter((s) => s !== 'built')) {
        const r = submission(h, `start-${state}`, { state });
        expect(await refused(h.store.recordSubmission(r)), state).toBe(true);
      }
    },
  },
  {
    name: 'accepts every forward move',
    rules: [],
    async run(h) {
      for (const from of STATES) {
        for (const to of SUBMISSION_TRANSITIONS[from]) {
          const r = submission(h, `forward-${from}-${to}`);
          await h.store.recordSubmission(r);
          await walk(h, r, from);
          await h.store.updateSubmission(r.scope, r.network, r.txHash, { state: to });
          expect(await live(h, r), `${from} to ${to}`).toEqual(
            ['built', 'broadcast', 'unknown'].includes(to) ? { ...r, state: to } : null,
          );
        }
      }
    },
  },
  {
    name: 'refuses every backward or sideways move and keeps the state',
    rules: ['forward_only'],
    async run(h) {
      for (const from of STATES) {
        for (const to of STATES.filter(
          (s) => s !== from && !SUBMISSION_TRANSITIONS[from].includes(s),
        )) {
          const r = submission(h, `backward-${from}-${to}`);
          await h.store.recordSubmission(r);
          await walk(h, r, from);
          const move = h.store.updateSubmission(r.scope, r.network, r.txHash, { state: to });
          expect(await refused(move), `${from} to ${to}`).toBe(true);
        }
      }
      const r = submission(h, 'backward-kept');
      await h.store.recordSubmission(r);
      await walk(h, r, 'unknown');
      expect(
        await refused(h.store.updateSubmission(r.scope, r.network, r.txHash, { state: 'built' })),
      ).toBe(true);
      expect((await live(h, r))?.state).toBe('unknown');
    },
  },
  {
    name: 'refuses an update from another tenant and changes nothing',
    rules: ['tenant_scope'],
    async run(h) {
      const r = submission(h, 'cross');
      await h.store.recordSubmission(r);
      const patch = { state: 'broadcast' } as const;
      expect(
        await refused(h.store.updateSubmission(h.otherScope, r.network, r.txHash, patch)),
      ).toBe(true);
      expect((await live(h, r))?.state).toBe('built');
    },
  },
  {
    name: 'finds a record in any state, for its own tenant only',
    rules: ['tenant_scope'],
    run: async (h) => {
      const r = submission(h, 'find-me');
      expect(await h.store.findSubmission(r.scope, r.network, r.txHash)).toBeNull();
      await h.store.recordSubmission(r);
      await walk(h, r, 'landed');
      expect(await h.store.findSubmission(r.scope, r.network, r.txHash)).toMatchObject({
        txHash: r.txHash,
        state: 'landed',
      });
      expect(await h.store.findSubmission(h.otherScope, r.network, r.txHash)).toBeNull();
    },
  },
  {
    name: 'lists unresolved submissions of every tenant, oldest first',
    rules: [],
    async run(h) {
      const a = submission(h, 'old-a');
      await h.store.recordSubmission(a);
      await h.advance(10n);
      const b = submission(h, 'old-b', { scope: h.otherScope });
      await h.store.recordSubmission(b);
      const c = submission(h, 'old-c');
      await h.store.recordSubmission(c);
      await walk(h, c, 'landed');
      await h.advance(10n);
      const found = await h.store.unresolvedSubmissions(h.network, 5, 10);
      expect(found.map((r) => r.txHash)).toEqual([a.txHash, b.txHash]);
      expect(found[1]?.scope).toEqual(h.otherScope);
      expect((await h.store.unresolvedSubmissions(h.network, 5, 1)).length).toBe(1);
      expect(await h.store.unresolvedSubmissions(h.network, 15, 10)).toEqual([
        expect.objectContaining({ txHash: a.txHash }),
      ]);
    },
  },
  {
    name: 'leases each executor to one holder at a time, with a new lease id each time',
    rules: [],
    async run(h) {
      const leases = [];
      for (let i = 0; i < h.executors; i += 1)
        leases.push(await h.store.leaseExecutor(h.network, 30));
      expect(new Set(leases.map((l) => l.address.value)).size).toBe(h.executors);
      expect(await refused(h.store.leaseExecutor(h.network, 30))).toBe(true);
      await h.advance(31n);
      const again = await h.store.leaseExecutor(h.network, 30);
      expect(leases.map((l) => l.leaseId)).not.toContain(again.leaseId);
    },
  },
  {
    name: 'refuses a release with a lease id that was taken over',
    rules: ['lease_fencing'],
    async run(h) {
      const first = [];
      for (let i = 0; i < h.executors; i += 1)
        first.push(await h.store.leaseExecutor(h.network, 10));
      await h.advance(11n);
      const taken = await h.store.leaseExecutor(h.network, 30);
      const stale = first.filter((l) => l.address.value === taken.address.value);
      expect(stale.length).toBe(1);
      for (const lease of stale) {
        const write = h.store.releaseExecutor(lease, {
          sequenceOrNonce: lease.sequenceOrNonce + 9n,
        });
        expect(await refused(write)).toBe(true);
      }
      await h.store.releaseExecutor(taken, { sequenceOrNonce: taken.sequenceOrNonce + 1n });
    },
  },
  {
    name: 'gives the next holder the sequence the last one released',
    rules: [],
    async run(h) {
      const lease = await h.store.leaseExecutor(h.network, 30);
      await h.store.releaseExecutor(lease, { sequenceOrNonce: lease.sequenceOrNonce + 5n });
      const all = [];
      for (let i = 0; i < h.executors; i += 1) all.push(await h.store.leaseExecutor(h.network, 30));
      const same = all.find((l) => l.address.value === lease.address.value);
      expect(same?.sequenceOrNonce).toBe(lease.sequenceOrNonce + 5n);
    },
  },
  {
    name: 'upserts a delivery on leg key, provider and reference',
    rules: [],
    async run(h) {
      const d = delivery(h, 'upsert');
      await h.store.upsertDelivery(d);
      const moved = { ...d, state: 'delivered' as const, rawStatus: 'completed' };
      await h.store.upsertDelivery(moved);
      expect(await h.store.liveDelivery(h.scope, d.legKey)).toEqual(moved);
    },
  },
  {
    name: 'refuses a second live delivery for a leg key and provider',
    rules: ['one_live_delivery'],
    async run(h) {
      const d = delivery(h, 'one');
      await h.store.upsertDelivery(d);
      expect(await refused(h.store.upsertDelivery({ ...d, providerRef: 'ref-two' }))).toBe(true);
      await h.store.upsertDelivery({ ...d, providerRef: 'ref-three', live: false });
      await h.store.upsertDelivery({ ...d, provider: 'anchor-b', providerRef: 'ref-four' });
      await h.store.upsertDelivery({ ...d, live: false });
      await h.store.upsertDelivery({ ...d, providerRef: 'ref-five' });
    },
  },
  {
    name: 'reads and writes deliveries for their own tenant only',
    rules: ['tenant_scope'],
    async run(h) {
      const d = delivery(h, 'tenant');
      await h.store.upsertDelivery(d);
      expect(await h.store.liveDelivery(h.otherScope, d.legKey)).toBe(null);
      const hijack = h.store.upsertDelivery({ ...d, scope: h.otherScope, state: 'failed' });
      expect(await refused(hijack)).toBe(true);
      expect((await h.store.liveDelivery(h.scope, d.legKey))?.state).toBe('in_transit');
    },
  },
] satisfies StoreCheck[]);

/** Runs every check against fresh stores and reports which passed. */
export async function runAdapterStoreChecks(
  factory: StoreHarnessFactory,
): Promise<readonly StoreCheckResult[]> {
  const results: StoreCheckResult[] = [];
  for (const check of STORE_CHECKS) {
    let passed = true;
    try {
      await check.run(await factory());
    } catch {
      // A failed check is the result being reported, not an error here.
      passed = false;
    }
    results.push({ name: check.name, rules: check.rules, passed });
  }
  return results;
}

/** Registers the store contract suite. The factory must return an empty store each time. */
export function describeAdapterStore(name: string, factory: StoreHarnessFactory): void {
  describe(`adapter store contract: ${name}`, () => {
    for (const check of STORE_CHECKS) {
      it(check.name, async () => {
        await check.run(await factory());
      });
    }
  });
}

export { STORE_RULES };
