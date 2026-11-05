// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The payout advance job. It never sleeps: each run reads where the payout is, takes
// one step and schedules the next, so a restart, a timeout or a retry only ever means
// running this again.
//
// What keeps a rerun from paying twice, whichever line a job dies on:
//
// - The database allows one live attempt per payout (payout_attempts_one_live), so a
//   rerun finds the attempt and never makes another without a dead proof.
// - The on-chain id derives from the idempotency key and the attempt number, so a
//   rerun asks the mandate about the same payout, which it records once, and the
//   database holds that id unique per instance (payout_attempts_chain_id).
// - adapter.pay is a step function over that id. It reconciles what it sent before it
//   sends anything, so asking again continues rather than repeats.
// - Every status write is compare and set, so of two runs one moves nothing.

import type {
  ChainAdapter,
  ChainAdapterError,
  DeadProof,
  MandateRef,
  NetworkId,
  PayRequest,
  PayStep,
  PayoutLegInput,
  RailId,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { isChainAdapterError } from '@ujira/chain-adapter';
import {
  fundingHolds,
  jobQueue,
  LiveAttemptError,
  payoutAttempts,
  payoutEngine,
  payoutLegs,
  payouts,
  recipients,
  type AttemptStatusValue,
  type LegStatusValue,
  type Payout,
  type PayoutAttempt,
  type PayoutLeg,
  type PayoutStatusValue,
  type TenantTx,
} from '@ujira/db';
import {
  RECEIPT_ISSUE_MAX_ATTEMPTS,
  RECEIPT_ISSUE_TASK,
  receiptIssueJobKey,
} from '@ujira/receipts';
import { selectRoute, type RouteOutcome, type RoutedOutcome } from '@ujira/router';

import { RetryableJobError } from '../worker/errors.js';
import { payoutAdvance, type TenantJob, type TenantWork } from '../worker/handlers.js';
import { enqueueTask, PAYOUT_ADVANCE, type TaskIds } from '../worker/tasks.js';
import { bytes32Of, legKeyOf, taskRefOf } from './ids.js';
import {
  attemptPlan,
  belowMinimum,
  collapsed,
  legsMeetMinimums,
  LostRace,
  nowOf,
  recordAttempt,
  routePlan,
  scopeOf,
  type EngineDeps,
  type RoutePlan,
} from './plan.js';
import {
  ATTEMPT_EDGES,
  LEG_EDGES,
  PAYOUT_EDGES,
  TERMINAL_PAYOUT,
  legStatusOf,
  pathTo,
  payoutAfterFinal,
  targetOf,
} from './status.js';

// When to look again. Nothing here waits: each is a job with a later run time.
export const ENGINE_TIMING = Object.freeze({
  finalityPollSeconds: 10,
  approvalPollSeconds: 60,
  deliveryPollSeconds: 60,
  waitPollSeconds: 300,
  // How many attempts before a payout that keeps dying is given up on.
  maxAttempts: 5,
});

interface Snapshot {
  readonly payout: Payout;
  readonly attempts: readonly PayoutAttempt[];
  readonly live: PayoutAttempt | undefined;
  readonly legs: readonly PayoutLeg[];
}

interface Prepared {
  readonly snapshot: Snapshot;
  readonly attempt: PayoutAttempt;
  readonly adapter: ChainAdapter;
  readonly request: PayRequest;
}

const idOf = (job: TenantJob): string => {
  const id = job.ids['payoutId'];
  if (id === undefined) throw new RangeError('a payout job names its payout');
  return id;
};

async function readSnapshot(job: TenantJob, deps: EngineDeps): Promise<Snapshot | undefined> {
  return deps.db.tenant(job.context).transaction(async (tx) => {
    const payout = await payouts.get(tx, idOf(job));
    if (payout === undefined) return undefined;
    const attempts = await payoutAttempts.forPayout(tx, payout.id);
    const live = attempts.find((attempt) => attempt.status !== 'dead');
    const legs = live === undefined ? [] : await payoutLegs.forAttempt(tx, live.id);
    return { payout, attempts, live, legs };
  });
}

// Under the same key, so a job already queued is replaced rather than joined. Starts
// the job's tries afresh, because getting here means it made progress.
async function scheduleNext(tx: TenantTx, ids: TaskIds, delaySeconds: number): Promise<void> {
  await enqueueTask(tx, PAYOUT_ADVANCE, ids, {
    ...(delaySeconds === 0 ? {} : { runAt: new Date(Date.now() + delaySeconds * 1_000) }),
  });
}

async function walkPayout(
  tx: TenantTx,
  payoutId: string,
  from: PayoutStatusValue,
  to: PayoutStatusValue,
): Promise<PayoutStatusValue> {
  const path = pathTo(PAYOUT_EDGES, from, to);
  if (path === null) return from;
  let at = from;
  for (const next of path) {
    const moved = await payouts.transition(tx, payoutId, { from: at, to: next });
    if (moved === undefined) throw new LostRace();
    at = next;
  }
  return at;
}

async function walkAttempt(
  tx: TenantTx,
  attempt: PayoutAttempt,
  to: AttemptStatusValue,
): Promise<void> {
  const from = attempt.status as AttemptStatusValue;
  const path = pathTo(ATTEMPT_EDGES, from, to);
  if (path === null) return;
  let at = from;
  for (const next of path) {
    if (next === 'dead') throw new Error('dying takes a proof, and is not a walk');
    const moved = await payoutAttempts.transition(tx, attempt.id, { from: at, to: next });
    if (moved === undefined) throw new LostRace();
    at = next;
  }
}

async function walkLeg(
  tx: TenantTx,
  leg: PayoutLeg,
  to: LegStatusValue,
  txHash: string | undefined,
): Promise<void> {
  const from = leg.status as LegStatusValue;
  const path = pathTo(LEG_EDGES, from, to);
  if (path === null) return;
  let at = from;
  for (const next of path) {
    const moved = await payoutLegs.transition(tx, leg.id, {
      from: at,
      to: next,
      ...(txHash === undefined ? {} : { chainTxHash: txHash }),
    });
    if (moved === undefined) throw new LostRace();
    at = next;
  }
}

// A lost race rolls this transaction back and ends the run, because the job that won
// is the one that schedules what comes next.
async function commit(
  job: TenantJob,
  deps: EngineDeps,
  work: (tx: TenantTx) => Promise<void>,
): Promise<void> {
  try {
    await deps.db.tenant(job.context).transaction(work);
  } catch (error) {
    if (!(error instanceof LostRace)) throw error;
  }
}

async function endPayout(
  job: TenantJob,
  deps: EngineDeps,
  from: PayoutStatusValue,
  to: 'rejected' | 'failed',
  code: string,
): Promise<void> {
  await commit(job, deps, async (tx) => {
    const ended = await payoutEngine.end(tx, idOf(job), { from, to, code });
    if (!ended) throw new LostRace();
  });
  if (to === 'failed') {
    deps.alert({
      kind: 'payout_failed',
      principalId: job.context.principalId,
      projectId: job.context.projectId,
      payoutId: idOf(job),
      reason: code,
    });
  }
}

async function routedOutcome(
  job: TenantJob,
  deps: EngineDeps,
  plan: RoutePlan,
): Promise<RouteOutcome> {
  const outcome = await selectRoute(plan.request, deps.routing);
  if (outcome.kind !== 'routed') return outcome;
  // Principal mode promises the local amount, which another method would not deliver.
  if (plan.firm !== undefined && outcome.methodFallback) return { kind: 'no_route' };
  if (await legsMeetMinimums(deps, job.context, outcome)) return outcome;
  if (plan.request.legs.length < 2) throw belowMinimum();
  // A split leg below its minimum: the whole payout goes to the main method instead.
  const single = await selectRoute(collapsed(plan, plan.request.total), deps.routing);
  if (single.kind !== 'routed') return single;
  if (!(await legsMeetMinimums(deps, job.context, single))) throw belowMinimum();
  return single;
}

async function record(
  job: TenantJob,
  deps: EngineDeps,
  payout: Payout,
  plan: RoutePlan,
  route: RoutedOutcome,
): Promise<boolean> {
  const key = await deps.db
    .tenant(job.context)
    .transaction(async (tx) => payoutEngine.idempotencyKey(tx, payout.id));
  if (key === undefined) throw new Error('a payout with no idempotency key');
  const attempt = await attemptPlan(deps, job.context, plan, route, key, job.signal);
  try {
    await deps.db.tenant(job.context).transaction(async (tx) => {
      await recordAttempt(tx, job.context, payout, attempt, plan.request.total, key);
    });
    return true;
  } catch (error) {
    // Another job made the attempt first, and it is the one that counts.
    if (error instanceof LiveAttemptError || error instanceof LostRace) return false;
    throw error;
  }
}

// Routes a payout with no live attempt, and records it. Undefined when there is nothing
// to submit: it is held, refused, or another job has it.
async function routeAndRecord(
  job: TenantJob,
  deps: EngineDeps,
  snapshot: Snapshot,
): Promise<Prepared | undefined> {
  const { payout, attempts } = snapshot;
  const status = payout.status as PayoutStatusValue;
  // A held payout is the release job's. Routing it here too is how it would be routed
  // twice.
  if (payout.statusReason === 'awaiting_funding') return undefined;
  if (attempts.length >= ENGINE_TIMING.maxAttempts) {
    await endPayout(job, deps, status, 'failed', 'ATTEMPTS_EXHAUSTED');
    return undefined;
  }
  const plan = await routePlan(deps, job.context, payout, job.signal);
  if (plan === undefined) {
    await endPayout(job, deps, status, 'rejected', 'NO_ROUTE');
    return undefined;
  }
  const outcome = await routedOutcome(job, deps, plan);
  switch (outcome.kind) {
    case 'hold':
      await commit(job, deps, async (tx) => {
        if (status === 'routed') {
          const back = await payouts.transition(tx, payout.id, { from: 'routed', to: 'received' });
          if (back === undefined) throw new LostRace();
        }
        const held = await fundingHolds.hold(tx, payout.id, outcome.networks);
        if (!held) throw new LostRace();
      });
      return undefined;
    case 'unavailable':
      await commit(job, deps, async (tx) => {
        await payoutEngine.markUnavailable(tx, payout.id);
      });
      throw new RetryableJobError('NETWORK_UNAVAILABLE');
    case 'no_route':
      await endPayout(job, deps, status, 'rejected', 'NO_ROUTE');
      return undefined;
    case 'routed':
      break;
  }
  await record(job, deps, payout, plan, outcome);
  const after = await readSnapshot(job, deps);
  return after?.live === undefined ? undefined : prepare(job, deps, after);
}

// Rebuilds the request from the rows, so a rerun sends exactly what the first run did.
async function prepare(
  job: TenantJob,
  deps: EngineDeps,
  snapshot: Snapshot,
): Promise<Prepared | undefined> {
  const { payout, live, legs } = snapshot;
  if (live === undefined) return undefined;
  if (live.onChainPayoutId === null) throw new Error('a live attempt with no on-chain id');
  const payoutId = live.onChainPayoutId as PayRequest['payoutId'];
  const network = live.network as NetworkId;
  const adapter = deps.adapters.get(network);
  const scope = scopeOf(job.context);
  const found = await deps.db.tenant(job.context).transaction(async (tx) => ({
    recipient: await recipients.get(tx, payout.recipientId),
    instance: await payoutEngine.instance(tx, live.mandateInstanceId),
  }));
  if (found.recipient === undefined) throw new Error('a payout names no recipient');
  if (found.instance === undefined) throw new Error('an attempt names no mandate instance');
  const mandate: MandateRef = {
    network,
    address: adapter.parseAddress(found.instance.contractAddress),
    specVersion: 1,
  };
  const legInputs = legs.map((leg): PayoutLegInput => {
    if (leg.rail === null) throw new Error('a leg of a live attempt names no rail');
    return {
      index: leg.index,
      legKey: legKeyOf(payoutId, leg.index),
      rail: leg.rail as RailId,
      recipientMethodId: leg.payoutMethodId as Uuid,
      amount: leg.amount,
      deliveryCurrency: leg.delivery?.receive.currency ?? leg.amount.asset,
      ...(leg.delivery === null
        ? {}
        : { quoteId: leg.delivery.quoteId as NonNullable<PayoutLegInput['quoteId']> }),
    };
  });
  // Only what has not been requested needs them, and an attester that is down should
  // not stop a payout that is already on chain.
  const attestations =
    live.status === 'created'
      ? (
          await deps.attestationsFor({
            scope,
            payoutId,
            attemptNumber: live.attemptNumber,
            network,
            legs: legInputs,
          })
        ).attestations
      : [];
  return {
    snapshot,
    attempt: live,
    adapter,
    request: {
      scope,
      mandate,
      payoutId,
      attempt: live.attemptNumber,
      recipientRef: bytes32Of(found.recipient.recipientRef),
      taskRef: taskRefOf(payout.id),
      total: live.total,
      fee: live.fee,
      legs: legInputs,
      deadline: BigInt(Math.floor(live.deadline.getTime() / 1_000)) as UnixSeconds,
      attestations,
      execute: 'auto',
      signer: deps.signerFor(scope, network),
    },
  };
}

const LEG_CANCELLABLE: ReadonlySet<string> = new Set(['planned', 'submitted']);

async function persistDead(
  job: TenantJob,
  deps: EngineDeps,
  prepared: Prepared,
  proof: DeadProof,
): Promise<void> {
  const { attempt, snapshot } = prepared;
  await commit(job, deps, async (tx) => {
    const dead = await payoutAttempts.markDead(tx, attempt.id, {
      from: attempt.status as Exclude<AttemptStatusValue, 'dead' | 'final'>,
      proof: proof,
    });
    if (dead === undefined) throw new LostRace();
    for (const leg of snapshot.legs) {
      const to = LEG_CANCELLABLE.has(leg.status) ? 'cancelled' : 'failed';
      await payoutLegs.transition(tx, leg.id, { from: leg.status as LegStatusValue, to });
    }
    const status = snapshot.payout.status as PayoutStatusValue;
    if (status !== 'routed') {
      const back = await payouts.transition(tx, snapshot.payout.id, { from: status, to: 'routed' });
      if (back === undefined) throw new LostRace();
    }
    // A dead proof is what frees the next attempt, so that goes on at once.
    await scheduleNext(tx, job.ids, 0);
  });
}

function nextPollOf(step: Exclude<PayStep, { readonly kind: 'dead' }>): number {
  switch (step.kind) {
    case 'submitted':
      return 0;
    case 'settled':
      return ENGINE_TIMING.finalityPollSeconds;
    case 'final':
      return ENGINE_TIMING.deliveryPollSeconds;
    case 'awaiting_approval':
    case 'held':
    case 'signature_required':
      return ENGINE_TIMING.approvalPollSeconds;
  }
}

async function persistFinal(
  tx: TenantTx,
  job: TenantJob,
  deps: EngineDeps,
  prepared: Prepared,
  at: PayoutStatusValue,
  delivered: ReadonlyMap<string, LegStatusValue>,
): Promise<void> {
  const { attempt, snapshot, request } = prepared;
  const payoutId = snapshot.payout.id;
  // These start from what this transaction has just written.
  const legs = await payoutLegs.forAttempt(tx, attempt.id);
  const states = legs.map(
    (leg) => delivered.get(legKeyOf(request.payoutId, leg.index)) ?? 'delivering',
  );
  for (const [index, leg] of legs.entries()) {
    const state = states[index];
    if (state !== undefined) await walkLeg(tx, leg, state, undefined);
  }
  if (states.includes('failed')) {
    await walkPayout(tx, payoutId, at, 'needs_attention');
    deps.alert({
      kind: 'payout_needs_attention',
      principalId: job.context.principalId,
      projectId: job.context.projectId,
      payoutId,
    });
    return;
  }
  const next = payoutAfterFinal(states);
  await walkPayout(tx, payoutId, at, next);
  if (next === 'paid') {
    // Keyed per payout, so a repeat of this adds nothing.
    await jobQueue.enqueue(tx, {
      task: RECEIPT_ISSUE_TASK,
      ids: { payoutId },
      jobKey: receiptIssueJobKey(payoutId),
      maxAttempts: RECEIPT_ISSUE_MAX_ATTEMPTS,
      keyMode: 'preserve_run_at',
    });
    return;
  }
  await scheduleNext(tx, job.ids, ENGINE_TIMING.deliveryPollSeconds);
}

async function persistStep(
  job: TenantJob,
  deps: EngineDeps,
  prepared: Prepared,
  step: Exclude<PayStep, { readonly kind: 'dead' }>,
): Promise<void> {
  const { attempt, snapshot, adapter, request } = prepared;
  const { payout, legs } = snapshot;
  const target = targetOf(step);
  if (target === null) {
    await commit(job, deps, async (tx) => {
      await scheduleNext(tx, job.ids, nextPollOf(step));
    });
    return;
  }
  const txHash =
    step.kind === 'submitted'
      ? step.submission.txHash
      : step.kind === 'settled' || step.kind === 'final'
        ? step.receipt.txHash
        : undefined;
  // Asked before the transaction opens, because it can reach a network.
  const delivery =
    step.kind === 'final'
      ? await adapter.status(
          {
            scope: request.scope,
            mandate: request.mandate,
            payoutId: request.payoutId,
            legs: request.legs.map((leg) => leg.legKey),
          },
          { signal: job.signal, correlationId: payout.id },
        )
      : undefined;
  await commit(job, deps, async (tx) => {
    await walkAttempt(tx, attempt, target.attempt);
    const at = await walkPayout(tx, payout.id, payout.status as PayoutStatusValue, target.payout);
    for (const leg of legs) await walkLeg(tx, leg, target.leg, txHash);
    if (delivery === undefined) {
      await scheduleNext(tx, job.ids, nextPollOf(step));
      return;
    }
    const delivered = new Map(delivery.legs.map((leg) => [leg.legKey, legStatusOf(leg.state)]));
    await persistFinal(tx, job, deps, prepared, at, delivered);
  });
}

// Waited out by looking again later, without using up a try.
const WAITS: ReadonlySet<unknown> = new Set(['funding', 'utc_day', 'resume', 'approval']);

async function cancelLapsed(job: TenantJob, deps: EngineDeps, prepared: Prepared): Promise<void> {
  const { attempt, request } = prepared;
  await deps.cancelLapsed(
    {
      scope: request.scope,
      mandateInstanceId: attempt.mandateInstanceId,
      network: request.mandate.network,
      payoutId: request.payoutId,
    },
    { signal: job.signal, correlationId: prepared.snapshot.payout.id },
  );
  await commit(job, deps, async (tx) => {
    await scheduleNext(tx, job.ids, ENGINE_TIMING.finalityPollSeconds);
  });
}

async function afterRefusal(
  job: TenantJob,
  deps: EngineDeps,
  prepared: Prepared,
  error: ChainAdapterError,
): Promise<void> {
  const { adapter, request, snapshot } = prepared;
  const options = { signal: job.signal, correlationId: snapshot.payout.id };
  if (WAITS.has(error.waitFor)) {
    await commit(job, deps, async (tx) => {
      await scheduleNext(tx, job.ids, ENGINE_TIMING.waitPollSeconds);
    });
    return;
  }
  if (error.retryable) throw new RetryableJobError(error.code, { cause: error });
  const name = (error as ChainAdapterError & { readonly specName?: string }).specName;
  if (name === 'PAYOUT_LAPSED') {
    await cancelLapsed(job, deps, prepared);
    return;
  }
  // The refusal itself reached nothing, but that says nothing about what an earlier
  // call put on chain. Only a payout the chain has never seen may end here. One it has
  // seen stays open with funds committed, so it goes to a person, by way of the bounded
  // retries and the dead letter.
  const onChain = await adapter.status(
    {
      scope: request.scope,
      mandate: request.mandate,
      payoutId: request.payoutId,
      legs: request.legs.map((leg) => leg.legKey),
    },
    options,
  );
  if (error.landed === 'no' && onChain.onChain === 'absent') {
    await endPayout(
      job,
      deps,
      snapshot.payout.status as PayoutStatusValue,
      'failed',
      name ?? error.code,
    );
    return;
  }
  throw new RetryableJobError(name ?? error.code, { cause: error });
}

// What cannot land any more is proven dead before the next attempt. A live attempt past
// its deadline with no proof stays exactly where it is, because it might still land,
// and only a proof may free the payout.
async function submit(job: TenantJob, deps: EngineDeps, prepared: Prepared): Promise<void> {
  const { adapter, request, attempt, snapshot } = prepared;
  const options = { signal: job.signal, correlationId: snapshot.payout.id };
  try {
    if (attempt.status !== 'final' && nowOf(deps) >= attempt.deadline.getTime()) {
      const proof = await adapter.proveDead(
        {
          scope: request.scope,
          mandate: request.mandate,
          payoutId: request.payoutId,
          deadline: request.deadline,
        },
        options,
      );
      if (proof !== null) {
        await persistDead(job, deps, prepared, proof);
        return;
      }
      const seen = await adapter.status(
        {
          scope: request.scope,
          mandate: request.mandate,
          payoutId: request.payoutId,
          legs: request.legs.map((leg) => leg.legKey),
        },
        options,
      );
      if (seen.lapsed) {
        await cancelLapsed(job, deps, prepared);
        return;
      }
    }
    const step = await adapter.pay(request, options);
    if (step.kind === 'dead') {
      await persistDead(job, deps, prepared, step.proof);
      return;
    }
    await persistStep(job, deps, prepared, step);
  } catch (error) {
    if (!isChainAdapterError(error)) throw error;
    await afterRefusal(job, deps, prepared, error);
  }
}

async function advanceQuote(job: TenantJob, deps: EngineDeps): Promise<Prepared | undefined> {
  const snapshot = await readSnapshot(job, deps);
  if (snapshot === undefined || TERMINAL_PAYOUT.has(snapshot.payout.status)) return undefined;
  if (snapshot.payout.status === 'needs_attention') return undefined;
  return snapshot.live === undefined
    ? routeAndRecord(job, deps, snapshot)
    : prepare(job, deps, snapshot);
}

export function advanceWork(deps: EngineDeps): TenantWork {
  return payoutAdvance<Prepared | undefined>({
    quote: (job) => advanceQuote(job, deps),
    submit: async (job, prepared) => {
      if (prepared !== undefined) await submit(job, deps, prepared);
    },
    // Reached from a payout with no attempt yet, so it is received, or routed again
    // after a dead attempt.
    reject: async (job, reason) => {
      const snapshot = await readSnapshot(job, deps);
      if (snapshot === undefined) return;
      await endPayout(job, deps, snapshot.payout.status as PayoutStatusValue, 'rejected', reason);
    },
  });
}

// The one way a new payout enters the engine, in the transaction that created it.
export async function enqueueAdvance(tx: TenantTx, payout: Payout): Promise<void> {
  await enqueueTask(tx, PAYOUT_ADVANCE, { payoutId: payout.id, mandateId: payout.mandateId });
}
