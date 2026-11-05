// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Moving a row to where the chain says it is. A job can die between any two writes, so
// the chain may be several steps ahead of the row, and the walk takes every step in
// between. The database's machines stay the authority: these lists only choose the
// path, and a step they do not allow is refused there.

import type { DeliveryState, PayStep } from '@ujira/chain-adapter';
import type { AttemptStatusValue, LegStatusValue, PayoutStatusValue } from '@ujira/db';

type Edges<S extends string> = Readonly<Record<S, readonly S[]>>;

export const ATTEMPT_EDGES: Edges<AttemptStatusValue> = {
  created: ['requested'],
  requested: ['pending_approval', 'approved', 'executing'],
  pending_approval: ['approved'],
  approved: ['executing'],
  executing: ['settled', 'final'],
  settled: ['final'],
  final: [],
  dead: [],
};

export const PAYOUT_EDGES: Edges<PayoutStatusValue> = {
  received: ['routed'],
  routed: ['submitting'],
  submitting: ['pending_approval', 'approved', 'settling'],
  pending_approval: ['approved'],
  approved: ['settling'],
  settling: ['delivering', 'partly_paid', 'paid', 'needs_attention'],
  delivering: ['partly_paid', 'paid', 'needs_attention'],
  partly_paid: ['delivering', 'paid', 'needs_attention'],
  paid: [],
  needs_attention: ['delivering', 'partly_paid', 'paid'],
  blocked: [],
  rejected: [],
  cancelled: [],
  failed: [],
};

export const LEG_EDGES: Edges<LegStatusValue> = {
  planned: ['submitted'],
  submitted: ['settled'],
  settled: ['delivering', 'delivered', 'failed'],
  delivering: ['delivered', 'failed'],
  delivered: [],
  failed: [],
  cancelled: [],
};

// The shortest way forward, or null when `to` is behind or beside `from`. A step from
// the chain that the row has already passed then moves nothing.
export function pathTo<S extends string>(edges: Edges<S>, from: S, to: S): readonly S[] | null {
  if (from === to) return [];
  const seen = new Set<S>([from]);
  const queue: { readonly at: S; readonly path: readonly S[] }[] = [{ at: from, path: [] }];
  for (const { at, path } of queue) {
    for (const next of edges[at]) {
      if (seen.has(next)) continue;
      if (next === to) return [...path, next];
      seen.add(next);
      queue.push({ at: next, path: [...path, next] });
    }
  }
  return null;
}

export const TERMINAL_PAYOUT: ReadonlySet<string> = new Set<PayoutStatusValue>([
  'paid',
  'rejected',
  'cancelled',
  'failed',
  'blocked',
]);

export interface StepTarget {
  readonly attempt: AttemptStatusValue;
  readonly payout: PayoutStatusValue;
  readonly leg: LegStatusValue;
}

// Where the on-chain axis puts the attempt, the payout and its legs. Final goes further,
// through the delivery axis, in payoutAfterFinal.
export function targetOf(step: Exclude<PayStep, { readonly kind: 'dead' }>): StepTarget | null {
  switch (step.kind) {
    case 'signature_required':
      return null;
    case 'submitted':
      return step.op === 'request'
        ? { attempt: 'requested', payout: 'submitting', leg: 'submitted' }
        : { attempt: 'executing', payout: 'settling', leg: 'submitted' };
    case 'awaiting_approval':
      return { attempt: 'pending_approval', payout: 'pending_approval', leg: 'submitted' };
    case 'held':
      return { attempt: 'approved', payout: 'approved', leg: 'submitted' };
    case 'settled':
      return { attempt: 'settled', payout: 'settling', leg: 'settled' };
    case 'final':
      return { attempt: 'final', payout: 'settling', leg: 'settled' };
  }
}

export function legStatusOf(state: DeliveryState): LegStatusValue {
  switch (state) {
    case 'not_applicable':
    case 'delivered':
      return 'delivered';
    case 'awaiting_settlement':
    case 'in_transit':
    case 'action_required':
      return 'delivering';
    case 'failed':
    case 'refunded':
    case 'expired':
      return 'failed';
  }
}

// The public status once the chain is final: paid only when every leg has arrived, and
// partly paid while some have and some have not.
export function payoutAfterFinal(legs: readonly LegStatusValue[]): PayoutStatusValue {
  if (legs.length > 0 && legs.every((leg) => leg === 'delivered')) return 'paid';
  return legs.some((leg) => leg === 'delivered') ? 'partly_paid' : 'delivering';
}
