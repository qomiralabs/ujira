// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What can go wrong between the adapter and a chain, on demand. A test
// either scripts a fault (the next submission times out after it lands) or
// gives the plan a seed and a rate per fault, and the plan then draws from
// its own generator at every decision point. Nothing reads the wall clock
// or Math.random, so one seed always gives one trace, and a failing
// property run can be replayed exactly.

import type { FiatCurrencyCode } from '@ujira/core';

import { InvalidInputError } from '../errors.js';
import type { CountryCode } from '../types.js';

/** Where a simulated process crash can cut a submission short. */
export type CrashPoint = 'after_record' | 'after_broadcast';

/** Faults drawn per decision point when the plan is randomized. */
export type RandomFault = 'timeoutAfterLanding' | 'chainDown' | CrashPoint;

/** Chance per decision point in basis points, an integer from 0 to 10000. */
export type FaultRates = Readonly<Partial<Record<RandomFault, number>>>;

/** One step of an anchor's scripted delivery, reached `afterSeconds` past settlement. */
export interface AnchorStep {
  readonly afterSeconds: number;
  readonly state: 'in_transit' | 'action_required' | 'delivered' | 'failed' | 'refunded';
  /** What the anchor would report, kept for support only. */
  readonly rawStatus: string;
}

/** How the fake SEP-31 anchor quotes and delivers. */
export interface AnchorScript {
  readonly anchorId: string;
  readonly currency: FiatCurrencyCode;
  readonly country: CountryCode;
  /** Delivery minor units per settlement unit, as a fraction. */
  readonly rate: { readonly numerator: bigint; readonly denominator: bigint };
  /** The anchor's fee in settlement units, paid by the recipient. */
  readonly fee: bigint;
  readonly steps: readonly AnchorStep[];
}

/**
 * Thrown where a simulated crash stops the adapter. It is not a chain
 * adapter error on purpose: a crash is the process dying, and whatever the
 * store and the chain hold at that moment is all the next process gets.
 */
export class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash';
  constructor(readonly point: CrashPoint) {
    super(`simulated crash ${point}`);
  }
}

const BPS = 10_000;

function checkCount(field: string, n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new InvalidInputError({ issues: [`${field} (invalid)`] });
  }
  return n;
}

/** mulberry32: small, fast and fully determined by its 32 bit seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export class FakeFaults {
  readonly seed: number;
  readonly #next: () => number;
  readonly #trace: string[] = [];
  #rates: FaultRates = {};
  #timeouts = 0;
  readonly #crashes = new Map<CrashPoint, number>();
  #down = false;
  #lagSeconds = 0;
  #signerDown = false;
  #sponsorDenied = false;
  #anchor: AnchorScript | null = null;
  readonly #refusing = new Set<string>();

  constructor(seed = 1) {
    if (!Number.isSafeInteger(seed)) throw new InvalidInputError({ issues: ['seed (invalid)'] });
    this.seed = seed;
    this.#next = generator(seed);
  }

  /** Every fault that fired and every adapter call outcome, in order. */
  get trace(): readonly string[] {
    return this.#trace;
  }

  note(line: string): void {
    this.#trace.push(line);
  }

  /** Draws each fault at its rate from now on. An empty object stops drawing. */
  randomize(rates: FaultRates): void {
    for (const [fault, bps] of Object.entries(rates)) {
      if (!Number.isSafeInteger(bps) || bps < 0 || bps > BPS) {
        throw new InvalidInputError({ issues: [`rates.${fault} (invalid)`] });
      }
    }
    this.#rates = { ...rates };
  }

  /** The next `count` submissions land, and the adapter hears a timeout instead of the result. */
  timeoutAfterLanding(count = 1): void {
    this.#timeouts += checkCount('count', count);
  }

  /** The next `count` submissions stop at `point`, as if the process died there. */
  crash(point: CrashPoint, count = 1): void {
    this.#crashes.set(point, (this.#crashes.get(point) ?? 0) + checkCount('count', count));
  }

  /** While on, nothing reaches the chain: reads and sends fail before anything is sent. */
  chainDown(on = true): void {
    this.#down = on;
  }

  /** The RPC view trails the chain by `seconds`; 0 catches it up. */
  rpcLag(seconds: number): void {
    this.#lagSeconds = checkCount('seconds', seconds);
  }

  signerDown(on = true): void {
    this.#signerDown = on;
  }

  /** While on, the sponsorship policy refuses every reservation. */
  sponsorDenied(on = true): void {
    this.#sponsorDenied = on;
  }

  /** Enables the SEP-31 rail with this anchor, or disables it with null. */
  anchorScript(script: AnchorScript | null): void {
    if (script !== null) {
      if (script.fee < 0n || script.rate.numerator < 1n || script.rate.denominator < 1n) {
        throw new InvalidInputError({ issues: ['anchor (invalid)'] });
      }
      for (const step of script.steps) checkCount('anchor.steps.afterSeconds', step.afterSeconds);
    }
    this.#anchor = script;
  }

  /** Every token transfer to `destination` fails while on, so the mandate sees TRANSFER_FAILED. */
  transferFails(destination: string, on = true): void {
    if (on) this.#refusing.add(destination);
    else this.#refusing.delete(destination);
  }

  /** Stops every fault, scripted or drawn. The anchor script and the trace stay. */
  clear(): void {
    this.#rates = {};
    this.#timeouts = 0;
    this.#crashes.clear();
    this.#down = false;
    this.#lagSeconds = 0;
    this.#signerDown = false;
    this.#sponsorDenied = false;
    this.#refusing.clear();
  }

  get lagSeconds(): number {
    return this.#lagSeconds;
  }

  get isSignerDown(): boolean {
    return this.#signerDown;
  }

  get isSponsorDenied(): boolean {
    return this.#sponsorDenied;
  }

  get anchor(): AnchorScript | null {
    return this.#anchor;
  }

  refuses(destination: string): boolean {
    return this.#refusing.has(destination);
  }

  /** Whether the chain is down for this call. Scripted state first, then a draw. */
  isChainDown(): boolean {
    return this.#down || this.#draw('chainDown');
  }

  /** Whether this submission's result is lost after it lands. */
  takeTimeout(): boolean {
    if (this.#timeouts > 0) {
      this.#timeouts -= 1;
      return this.#fired('timeoutAfterLanding');
    }
    return this.#draw('timeoutAfterLanding');
  }

  /** Throws SimulatedCrash when a crash is due at `point`. */
  crashPoint(point: CrashPoint): void {
    const due = this.#crashes.get(point) ?? 0;
    if (due > 0) {
      this.#crashes.set(point, due - 1);
      this.#fired(point);
      throw new SimulatedCrash(point);
    }
    if (this.#draw(point)) throw new SimulatedCrash(point);
  }

  #draw(fault: RandomFault): boolean {
    const bps = this.#rates[fault] ?? 0;
    if (bps === 0) return false;
    return this.#next() % BPS < bps ? this.#fired(fault) : false;
  }

  #fired(fault: string): true {
    this.#trace.push(`fault ${fault}`);
    return true;
  }
}
