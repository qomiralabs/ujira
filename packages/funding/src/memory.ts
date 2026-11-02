// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The ports in memory, for tests and until the funding_sweeps table lands.
// The store enforces what the table must: one row per chain and deposit
// operation id, tenant checked on every read and write, and a state move
// only from the state the caller named.

import { chainOf } from '@ujira/chain-adapter';

import { SweepStateError } from './errors.js';
import type {
  SweepKey,
  SweepPatch,
  SweepPrompt,
  SweepPrompts,
  SweepRecord,
  SweepReports,
  SweepStatus,
  SweepStore,
} from './sweep.js';

function uniqueKey(chain: string, depositOperationId: string): string {
  return `${chain}|${depositOperationId}`;
}

export class MemorySweepStore implements SweepStore {
  /** The next markPrompted throws this, as a crash between the two writes would. */
  failNextMarkPrompted: Error | null = null;
  readonly #rows = new Map<string, SweepRecord>();

  rows(): readonly SweepRecord[] {
    return [...this.#rows.values()];
  }

  #own(key: SweepKey): SweepRecord | null {
    const row = this.#rows.get(uniqueKey(chainOf(key.network), key.depositOperationId));
    if (row === undefined) return null;
    const { principalId, projectId } = key.scope;
    return row.principalId === principalId && row.projectId === projectId ? row : null;
  }

  insertIfAbsent(row: SweepRecord): Promise<SweepRecord> {
    const unique = uniqueKey(row.chain, row.depositOperationId);
    const existing = this.#rows.get(unique);
    if (existing !== undefined) return Promise.resolve(existing);
    this.#rows.set(unique, row);
    return Promise.resolve(row);
  }

  get(key: SweepKey): Promise<SweepRecord | null> {
    return Promise.resolve(this.#own(key));
  }

  markPrompted(key: SweepKey, at: bigint): Promise<void> {
    if (this.failNextMarkPrompted !== null) {
      const error = this.failNextMarkPrompted;
      this.failNextMarkPrompted = null;
      return Promise.reject(error);
    }
    const row = this.#own(key);
    if (row === null) return Promise.reject(new SweepStateError());
    this.#put({ ...row, promptedAt: at });
    return Promise.resolve();
  }

  transition(key: SweepKey, from: SweepStatus, patch: SweepPatch): Promise<SweepRecord> {
    const row = this.#own(key);
    if (row?.status !== from) return Promise.reject(new SweepStateError());
    return Promise.resolve(this.#put({ ...row, ...patch }));
  }

  #put(row: SweepRecord): SweepRecord {
    this.#rows.set(uniqueKey(row.chain, row.depositOperationId), row);
    return row;
  }
}

/** An outbox in miniature: a repeated idempotency key delivers nothing. */
export class RecordingSweepPrompts implements SweepPrompts {
  #attempts = 0;
  readonly #delivered = new Map<string, SweepPrompt>();

  requestSignature(prompt: SweepPrompt, idempotencyKey: string): Promise<void> {
    this.#attempts += 1;
    if (!this.#delivered.has(idempotencyKey)) this.#delivered.set(idempotencyKey, prompt);
    return Promise.resolve();
  }

  attempts(): number {
    return this.#attempts;
  }

  delivered(): readonly SweepPrompt[] {
    return [...this.#delivered.values()];
  }
}

export class RecordingSweepReports implements SweepReports {
  readonly #events: Parameters<SweepReports['sweepFailed']>[0][] = [];

  sweepFailed(event: Parameters<SweepReports['sweepFailed']>[0]): void {
    this.#events.push(event);
  }

  events(): readonly Parameters<SweepReports['sweepFailed']>[0][] {
    return [...this.#events];
  }
}
