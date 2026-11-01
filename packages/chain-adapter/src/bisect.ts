// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How an execute batch is cut down to what will pay. The mandate executes a
// batch atomically, so one bad item reverts every other one. Before anything
// is signed the whole batch is simulated; when it fails, the offender is
// found by simulating ever shorter prefixes, removed with its own error, and
// the rest simulated again. Prefixes rather than arbitrary halves, because
// each item's transfers run before the next item's checks: an item can fail
// only because of what came before it, and a prefix keeps that history.
//
// A batch that overflows the network's contract events limit is a different
// failure: no item is at fault, so it is split in half and each half tried
// on its own, and an alert is raised, since batches within the spec limits
// should never get there.
//
// Nothing here knows a chain. Each adapter supplies the simulation port.

import { InvalidInputError } from './errors.js';
import type { ChainAdapterError, MandateRuleError } from './errors.js';

/** What simulating one candidate batch came to. */
export type BatchSimulation =
  | { readonly ok: true }
  /** The mandate refused the batch, with the first failing item's error. */
  | { readonly ok: false; readonly kind: 'refused'; readonly error: MandateRuleError }
  /** The batch's events overflowed the network's limit; no item is to blame. */
  | { readonly ok: false; readonly kind: 'events_limit' }
  /** Anything else, such as an outage. No item caused it, so planning stops. */
  | { readonly ok: false; readonly kind: 'error'; readonly error: ChainAdapterError };

/** Implemented by each chain adapter over its own simulation call. */
export interface BatchSimulationPort<Item> {
  simulate(items: readonly Item[]): Promise<BatchSimulation>;
}

export interface BatchPlanOptions {
  /** Prefix simulations allowed in one step, across every offender. */
  readonly maxBisectRounds: number;
}

/** Why the plan raised an alert. */
export type BatchAlert<Item> =
  | { readonly kind: 'events_limit'; readonly size: number }
  | { readonly kind: 'agent_removed'; readonly item: Item };

export interface BatchPlan<Item> {
  /** Batches that simulated clean, in order, each to be submitted as one. */
  readonly batches: readonly (readonly Item[])[];
  /** Items removed, each with the mandate error that convicted it. Never retried. */
  readonly failed: readonly { readonly item: Item; readonly error: MandateRuleError }[];
  /** Items left undecided when the round bound was hit; the next step tries them. */
  readonly deferred: readonly Item[];
  readonly alerts: readonly BatchAlert<Item>[];
  /** Prefix simulations spent finding offenders. */
  readonly rounds: number;
  /** Every simulation run, whole batches included. */
  readonly simulations: number;
}

/** The mandate's code for a payout whose agent was removed. */
const AGENT_REMOVED = 65;

/** The rounds one offender can cost in a batch of n: ceil(log2(n)). */
export function bisectRounds(n: number): number {
  let rounds = 0;
  while (2 ** rounds < n) rounds += 1;
  return rounds;
}

/**
 * Plans an execute batch: which items go out together, which fail on their
 * own, and which wait for the next step because the round bound was hit.
 * Order is kept everywhere, since order decides what each item sees.
 */
export async function planBatch<Item>(
  items: readonly Item[],
  port: BatchSimulationPort<Item>,
  options: BatchPlanOptions,
): Promise<BatchPlan<Item>> {
  const max = options.maxBisectRounds;
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new InvalidInputError({ issues: ['maxBisectRounds (invalid)'] });
  }
  const batches: Item[][] = [];
  const failed: { item: Item; error: MandateRuleError }[] = [];
  const deferred: Item[] = [];
  const alerts: BatchAlert<Item>[] = [];
  let rounds = 0;
  let simulations = 0;
  type Decided = Exclude<BatchSimulation, { readonly kind: 'error' }>;
  const simulate = async (candidate: readonly Item[]): Promise<Decided> => {
    simulations += 1;
    const result = await port.simulate(candidate);
    if (result.ok || result.kind !== 'error') return result;
    throw result.error;
  };

  const queue: Item[][] = items.length === 0 ? [] : [[...items]];
  for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
    const result = await simulate(batch);
    if (result.ok) {
      batches.push(batch);
      continue;
    }
    if (result.kind === 'events_limit') {
      alerts.push({ kind: 'events_limit', size: batch.length });
      // A single item over the limit cannot be split further, so it waits
      // for someone to look rather than being retried blindly.
      if (batch.length === 1) deferred.push(...batch);
      else {
        const half = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(0, half), batch.slice(half));
      }
      continue;
    }
    // Refused: find the shortest failing prefix. Its last item is the
    // offender, and the prefix before it is known to pass.
    let error = result.error;
    let lo = 1;
    let hi = batch.length;
    let undecided = false;
    while (lo < hi && !undecided) {
      if (rounds >= max) {
        undecided = true;
        continue;
      }
      const mid = Math.floor((lo + hi) / 2);
      rounds += 1;
      const prefix = await simulate(batch.slice(0, mid));
      if (prefix.ok) lo = mid + 1;
      else if (prefix.kind === 'refused') {
        hi = mid;
        error = prefix.error;
      } else {
        // An events overflow on a prefix leaves the offender unknown.
        undecided = true;
      }
    }
    if (undecided) {
      deferred.push(...batch, ...queue.flat());
      break;
    }
    const rest: Item[] = [];
    batch.forEach((item, i) => {
      if (i !== lo - 1) {
        rest.push(item);
        return;
      }
      failed.push({ item, error });
      // A removed agent's payout can never execute; its principal should
      // know one was still queued.
      if (error.specCode === AGENT_REMOVED) alerts.push({ kind: 'agent_removed', item });
    });
    if (rest.length > 0) queue.unshift(rest);
  }
  return { batches, failed, deferred, alerts, rounds, simulations };
}
