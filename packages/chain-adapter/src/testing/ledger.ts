// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fake chain itself: one clock, the contracts living on it, the event
// log and the call stack. Every invocation runs inside a frame that saves
// the state of every contract first, so a call that fails leaves nothing
// behind, as on a real chain, and the host's refusal of a nested call into
// a contract already on the stack is enforced here rather than trusted to
// each contract.

import { InvalidInputError } from '../errors.js';

import { sha256, utf8 } from './bytes.js';
import { NestedCallRefused } from './failures.js';
import type { EngineEvent, EventValue, TokenEvent } from './types.js';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

/**
 * Whether a view of a contract already on the call stack is answered. The
 * Stellar host refuses every such call, views included, which is the
 * default. 'answer' is the other behaviour the spec describes, where a view
 * read during a callback may show mid-call state and must never be treated
 * as final.
 */
export type NestedViews = 'refuse' | 'answer';

export interface FakeLedgerOptions {
  /** Unix seconds. */
  readonly now: bigint;
  readonly networkPassphrase?: string;
  readonly nestedViews?: NestedViews;
}

/** A contract whose state the ledger can save and restore around a call. */
export interface LedgerContract {
  readonly address: string;
  /** Saves the state and returns what puts it back. */
  checkpoint(): () => void;
}

type FrameKind = 'call' | 'view';

export class FakeLedger {
  readonly networkPassphrase: string;
  readonly networkId: Uint8Array;
  readonly nestedViews: NestedViews;
  #now: bigint;
  readonly #contracts = new Map<string, LedgerContract>();
  readonly #stack: string[] = [];
  readonly #events: EngineEvent[] = [];
  readonly #tokenEvents: TokenEvent[] = [];

  constructor(options: FakeLedgerOptions) {
    this.#now = checkTime('now', options.now);
    this.networkPassphrase = options.networkPassphrase ?? TESTNET_PASSPHRASE;
    this.networkId = sha256(utf8(this.networkPassphrase));
    this.nestedViews = options.nestedViews ?? 'refuse';
  }

  /** The ledger time in unix seconds; one value per call. */
  get now(): bigint {
    return this.#now;
  }

  /** Moves the clock to `now`, never backwards. */
  setTime(now: bigint): void {
    const to = checkTime('now', now);
    if (to < this.#now) throw new InvalidInputError({ issues: ['now (backwards)'] });
    this.#now = to;
  }

  advance(seconds: bigint): void {
    this.setTime(this.#now + checkTime('seconds', seconds));
  }

  /** Every event the mandates and factories emitted in calls that landed, in order. */
  get events(): readonly EngineEvent[] {
    return this.#events;
  }

  /** Every token event of the operations that landed, in order. */
  get tokenEvents(): readonly TokenEvent[] {
    return this.#tokenEvents;
  }

  register(contract: LedgerContract): void {
    if (this.#contracts.has(contract.address)) {
      throw new InvalidInputError({ issues: ['contract (exists)'] });
    }
    this.#contracts.set(contract.address, contract);
  }

  contract(address: string): LedgerContract | undefined {
    return this.#contracts.get(address);
  }

  /** Whether a call of `address` is in progress. */
  isExecuting(address: string): boolean {
    return this.#stack.includes(address);
  }

  emit(contract: string, name: string, fields: Readonly<Record<string, EventValue>>): void {
    this.#events.push(Object.freeze({ contract, name, fields: Object.freeze({ ...fields }) }));
  }

  emitToken(event: TokenEvent): void {
    this.#tokenEvents.push(Object.freeze({ ...event }));
  }

  /**
   * Runs `body` as an invocation of `contract`. A state-changing call saves
   * every contract first and puts it all back if the body throws, so a
   * failed call, nested or not, changes nothing and emits nothing.
   */
  invoke<T>(contract: string, kind: FrameKind, body: () => T): T {
    if (this.#stack.includes(contract)) {
      if (kind === 'view' && this.nestedViews === 'answer') return body();
      throw new NestedCallRefused(contract);
    }
    if (kind === 'view') {
      this.#stack.push(contract);
      try {
        return body();
      } finally {
        this.#stack.pop();
      }
    }
    const restore = this.#checkpoint();
    this.#stack.push(contract);
    try {
      return body();
    } catch (error) {
      restore();
      throw error;
    } finally {
      this.#stack.pop();
    }
  }

  #checkpoint(): () => void {
    const restores = [...this.#contracts.values()].map((c) => c.checkpoint());
    const events = this.#events.length;
    const tokenEvents = this.#tokenEvents.length;
    return () => {
      for (const restore of restores) restore();
      this.#events.length = events;
      this.#tokenEvents.length = tokenEvents;
    };
  }
}

function checkTime(field: string, value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n) {
    throw new InvalidInputError({ issues: [`${field} (invalid)`] });
  }
  return value;
}
