// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fakes for the keep-alive job: a ledger that models time to live, archiving,
// restores and extensions, a step store that enforces the same uniqueness
// the database table will, and counters a test can read. The ledger refuses
// what the network refuses, so a job that extends an archived entry fails
// here as it would on chain.

import { SubmissionRejectedError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type {
  EntryTtl,
  TtlClaim,
  TtlMetricLabels,
  TtlMetricName,
  TtlMetrics,
  TtlReader,
  TtlStep,
  TtlStepStore,
  TtlSubmission,
  TtlSubmitter,
} from '../stellar/ttl-job.js';

export type FakeTtlCall =
  | { readonly action: 'restore'; readonly keys: readonly string[] }
  | {
      readonly action: 'extend';
      readonly keys: readonly string[];
      readonly extendToLedgers: number;
    };

interface FakeEntry {
  liveUntil: number;
  archived: boolean;
}

/** Entries by ledger key, as one network's RPC and sponsored submitter see them. */
export class FakeTtlLedger implements TtlReader, TtlSubmitter {
  latestLedger: number;
  /** Reads keep answering what they saw before the last write, like a lagging node. */
  lagReads = false;
  /** Reads never answer, to exercise the deadline. */
  hangReads = false;
  /** Submissions never answer, as a send that was lost on the way back. */
  hangSubmissions = false;
  readonly calls: FakeTtlCall[] = [];
  readonly #restoredTtlLedgers: number;
  readonly #entries = new Map<string, FakeEntry>();
  #lagged: Map<string, EntryTtl> | null = null;
  readonly #failures = new Map<'restore' | 'extend', unknown>();
  #txCount = 0;

  constructor(options: { readonly latestLedger: number; readonly restoredTtlLedgers: number }) {
    this.latestLedger = options.latestLedger;
    this.#restoredTtlLedgers = options.restoredTtlLedgers;
  }

  put(key: string, liveUntil: number): void {
    this.#entries.set(key, { liveUntil, archived: false });
  }

  archive(key: string): void {
    this.#entries.set(key, { liveUntil: 0, archived: true });
  }

  remove(key: string): void {
    this.#entries.delete(key);
  }

  advance(ledgers: number): void {
    this.latestLedger += ledgers;
  }

  liveUntil(key: string): number | undefined {
    return this.#entries.get(key)?.liveUntil;
  }

  isArchived(key: string): boolean {
    return this.#entries.get(key)?.archived === true;
  }

  /** The next call of this action throws `error`, after being recorded. */
  failNext(action: 'restore' | 'extend', error: unknown): void {
    this.#failures.set(action, error);
  }

  #view(key: string): EntryTtl | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    return entry.archived
      ? { key, state: 'archived' }
      : { key, state: 'live', liveUntilLedgerSeq: entry.liveUntil };
  }

  readTtl(
    _network: StellarNetworkId,
    keys: readonly string[],
  ): Promise<{ readonly latestLedger: number; readonly entries: readonly EntryTtl[] }> {
    if (this.hangReads) return new Promise(() => undefined);
    const entries = keys.flatMap((key) => {
      const view = this.lagReads && this.#lagged !== null ? this.#lagged.get(key) : this.#view(key);
      return view === undefined ? [] : [view];
    });
    return Promise.resolve({ latestLedger: this.latestLedger, entries });
  }

  #snapshot(): void {
    if (!this.lagReads) return;
    this.#lagged = new Map(
      [...this.#entries.keys()].flatMap((key) => {
        const view = this.#view(key);
        return view === undefined ? [] : [[key, view] as const];
      }),
    );
  }

  #consumeFailure(action: 'restore' | 'extend'): void {
    if (!this.#failures.has(action)) return;
    const error = this.#failures.get(action);
    this.#failures.delete(action);
    throw error;
  }

  #hash(): { readonly txHash: string } {
    this.#txCount += 1;
    return { txHash: this.#txCount.toString(16).padStart(64, '0') };
  }

  restore(req: TtlSubmission): Promise<{ readonly txHash: string }> {
    return this.#run(() => {
      this.calls.push({ action: 'restore', keys: req.keys });
      this.#consumeFailure('restore');
      for (const key of req.keys) {
        if (this.#entries.get(key)?.archived !== true) {
          throw new SubmissionRejectedError({ network: req.network });
        }
      }
      for (const key of req.keys) {
        this.put(key, this.latestLedger + this.#restoredTtlLedgers);
      }
      return this.#hash();
    });
  }

  extend(
    req: TtlSubmission & { readonly extendToLedgers: number },
  ): Promise<{ readonly txHash: string }> {
    return this.#run(() => {
      this.calls.push({
        action: 'extend',
        keys: req.keys,
        extendToLedgers: req.extendToLedgers,
      });
      this.#consumeFailure('extend');
      for (const key of req.keys) {
        const entry = this.#entries.get(key);
        if (entry === undefined || entry.archived) {
          throw new SubmissionRejectedError({ network: req.network });
        }
      }
      for (const key of req.keys) {
        const entry = this.#entries.get(key);
        const current = entry?.liveUntil ?? 0;
        this.put(key, Math.max(current, this.latestLedger + req.extendToLedgers));
      }
      return this.#hash();
    });
  }

  #run<T>(body: () => T): Promise<T> {
    this.#snapshot();
    if (this.hangSubmissions) return new Promise(() => undefined);
    // A throw inside the executor becomes the rejection, as it would from a port.
    return new Promise((resolve) => {
      resolve(body());
    });
  }
}

interface StoredStep {
  readonly step: TtlStep;
  state: 'pending' | 'landed' | 'failed';
  txHash: string | null;
}

function stepKey(step: TtlStep): string {
  return [
    step.scope.principalId,
    step.scope.projectId,
    step.network,
    step.mandate,
    String(step.window),
    step.action,
    step.keysHash,
  ].join('|');
}

/** Unique on every field of the step, as the table behind this port must be. */
export class MemoryTtlStepStore implements TtlStepStore {
  readonly #steps = new Map<string, StoredStep>();

  claim(step: TtlStep): Promise<TtlClaim> {
    const key = stepKey(step);
    const stored = this.#steps.get(key);
    if (stored !== undefined && stored.state !== 'failed') {
      return Promise.resolve({ claimed: false, state: stored.state });
    }
    this.#steps.set(key, { step, state: 'pending', txHash: null });
    return Promise.resolve({ claimed: true });
  }

  settle(
    step: TtlStep,
    outcome: { readonly state: 'landed'; readonly txHash: string } | { readonly state: 'failed' },
  ): Promise<void> {
    const stored = this.#steps.get(stepKey(step));
    if (stored === undefined) return Promise.reject(new Error('settling a step never claimed'));
    stored.state = outcome.state;
    stored.txHash = outcome.state === 'landed' ? outcome.txHash : null;
    return Promise.resolve();
  }

  steps(): readonly TtlStep[] {
    return [...this.#steps.values()].map((stored) => stored.step);
  }
}

/** Counters and the label sets they were raised with. */
export class RecordingTtlMetrics implements TtlMetrics {
  readonly #seen: { name: TtlMetricName; labels: TtlMetricLabels; by: number }[] = [];

  increment(name: TtlMetricName, labels: TtlMetricLabels, by: number): void {
    this.#seen.push({ name, labels, by });
  }

  total(name: TtlMetricName): number {
    return this.#seen.filter((m) => m.name === name).reduce((sum, m) => sum + m.by, 0);
  }

  labels(name: TtlMetricName): readonly TtlMetricLabels[] {
    return this.#seen.filter((m) => m.name === name).map((m) => m.labels);
  }
}
