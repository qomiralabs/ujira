// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Returns a revoked or expired mandate's funds to its principal. UJIRA never holds
// them: the only way out is the adapter's sweep, which takes no destination, so the
// contract pays its own principal and no input here can send money anywhere else.
//
// A principal who cannot receive yet (no trustline, a blocked account) is retried on
// the handler's own curve and told once per reason how to fix it. Every run starts
// from the chain, so a withdraw or an earlier sweep that already landed ends the job
// rather than being repeated, and a sweep the contract would refuse is never sent:
// the grace after expiry and a pending principal change are waited out, and money a
// third party sent in holds the sweep until operations clear it.

import { SWEEP_GRACE_SECONDS, isNetworkId } from '@ujira/chain-adapter';
import type {
  ChainAdapter,
  MandateRef,
  MandateSnapshot,
  NetworkId,
  ReceivabilityReason,
  SubmissionRef,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import type { TokenAmount } from '@ujira/core';
import { z } from 'zod';

import { isTransferFailed } from './fee-fallback.js';

export const RETURN_FUNDS_TASK = 'mandate:return_funds';

/** The handler's own retry curve for a principal who cannot receive yet. */
export const RETURN_FUNDS_BACKOFF = Object.freeze({
  firstMs: 5_000,
  maxMs: 600_000,
  deadLetterAt: 12,
});

// A sweep held for someone else's decision is freed by its event. This is the backstop
// in case that event is missed, so a held return is never forgotten.
const HELD_RECHECK_SECONDS = 3_600n;
const CALL_DEADLINE_MS = 30_000;

/** One job per mandate instance, so two triggers can never sweep side by side. */
export function returnFundsJobKey(instanceId: string): string {
  return `mandate:${instanceId}:return_funds`;
}

/** The wait after `tries` failed tries: 5 s, doubling, capped at 600 s. */
export function returnFundsDelayMs(tries: number): number {
  if (!Number.isInteger(tries) || tries < 1) throw new RangeError('tries counts from 1');
  const { firstMs, maxMs } = RETURN_FUNDS_BACKOFF;
  return Math.min(firstMs * 2 ** (tries - 1), maxMs);
}

const payloadSchema = z.strictObject({
  principalId: z.guid(),
  projectId: z.guid(),
  instanceId: z.guid(),
  network: z.string().refine(isNetworkId),
  mandate: z.string().min(1).max(128),
  tries: z
    .int()
    .min(0)
    .max(RETURN_FUNDS_BACKOFF.deadLetterAt - 1),
});

export interface ReturnFundsPayload {
  readonly principalId: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly network: string;
  /** The mandate's address on that network. */
  readonly mandate: string;
  /** Failed tries so far. */
  readonly tries: number;
}

/** A payload the job cannot read. It names the fields, never what they held. */
export class ReturnFundsPayloadError extends Error {
  override readonly name = 'ReturnFundsPayloadError';
  readonly code = 'RETURN_FUNDS_PAYLOAD_INVALID';
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`the return funds payload is invalid: ${issues.join(', ')}`);
    this.issues = issues;
  }
}

function parsePayload(raw: unknown): ReturnFundsPayload {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) =>
      issue.path.length === 0 ? '(payload)' : issue.path.join('.'),
    );
    throw new ReturnFundsPayloadError([...new Set(issues)]);
  }
  return parsed.data;
}

/** Everything that can move money here is the sweep, and it has nowhere to name. */
export type ReturnFundsAdapter = Pick<
  ChainAdapter,
  'readMandate' | 'sweepToPrincipal' | 'checkDestination'
>;

/**
 * What the indexer's attribution says of money a third party sent into the instance:
 * none, found with no alert yet, alerted to operations, or cleared by them.
 */
export type InflowState = 'none' | 'detected' | 'alerted' | 'cleared';

interface StoreOptions {
  readonly signal: AbortSignal;
}

export interface ReturnFundsStore {
  inflow(scope: TenantScope, instanceId: string, opts: StoreOptions): Promise<InflowState>;
  /** Raises the inflow alert for operations. Raising it again changes nothing. */
  raiseInflowAlert(scope: TenantScope, instanceId: string, opts: StoreOptions): Promise<void>;
  /** True only the first time for this instance and reason, under a unique constraint. */
  firstNotice(
    scope: TenantScope,
    instanceId: string,
    reason: ReturnFundsNotice['reason'],
    opts: StoreOptions,
  ): Promise<boolean>;
}

/** What the principal can do so the funds can come back. */
export type ReturnFundsFix =
  'add_trustline' | 'raise_trustline_limit' | 'transfer_to_receivable_principal';

export interface ReturnFundsNotice {
  readonly scope: TenantScope;
  readonly instanceId: string;
  readonly mandate: MandateRef;
  /** UNEXPLAINED when the chain refused but the destination check sees no reason. */
  readonly reason: ReceivabilityReason | 'UNEXPLAINED';
  readonly fix: ReturnFundsFix;
}

export interface ReturnFundsNotices {
  cannotReceive(notice: ReturnFundsNotice): Promise<void>;
}

export interface ReturnFundsAlerts {
  /** The job gave up. Operations take it from here. */
  deadLetter(alert: {
    readonly scope: TenantScope;
    readonly instanceId: string;
    readonly reason: 'TRANSFER_FAILED';
  }): Promise<void>;
}

export interface ReturnFundsDeps {
  readonly adapter: ReturnFundsAdapter;
  readonly store: ReturnFundsStore;
  readonly notices: ReturnFundsNotices;
  readonly alerts: ReturnFundsAlerts;
  /** Bound on the whole run. */
  readonly timeoutMs?: number;
}

export type ReturnFundsOutcome =
  /** Nothing to do: the balance is already gone, or the mandate is still open. */
  | { readonly kind: 'done'; readonly reason: 'nothing_left' | 'not_closed' }
  | { readonly kind: 'swept'; readonly submission: SubmissionRef }
  /** Run again at `runAt`, or sooner when the event that frees it arrives. */
  | {
      readonly kind: 'wait';
      readonly reason: 'grace' | 'principal_change' | 'third_party_inflow';
      readonly runAt: UnixSeconds;
    }
  /** Enqueue `payload` again after `delayMs`. */
  | { readonly kind: 'retry'; readonly delayMs: number; readonly payload: ReturnFundsPayload }
  | { readonly kind: 'dead_letter'; readonly reason: 'TRANSFER_FAILED'; readonly tries: number };

const FIXES: Readonly<Record<ReturnFundsNotice['reason'], ReturnFundsFix>> = Object.freeze({
  NO_TRUSTLINE: 'add_trustline',
  TRUSTLINE_LIMIT: 'raise_trustline_limit',
  TRUSTLINE_NOT_AUTHORIZED: 'transfer_to_receivable_principal',
  ACCOUNT_NOT_FOUND: 'transfer_to_receivable_principal',
  DESTINATION_IS_ISSUER: 'transfer_to_receivable_principal',
  UNEXPLAINED: 'transfer_to_receivable_principal',
});

// What the contract refuses a sweep for, and what that means for this job.
function refusalOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, specName } = error as { code?: unknown; specName?: unknown };
  return code === 'MANDATE_RULE' && typeof specName === 'string' ? specName : null;
}

function held(
  reason: 'grace' | 'principal_change' | 'third_party_inflow',
  runAt: bigint,
): ReturnFundsOutcome {
  return { kind: 'wait', reason, runAt: runAt as UnixSeconds };
}

/**
 * One run of `mandate:return_funds`. Run it again with the payload it hands back,
 * or with the same one after a wait. A failed read or write throws, typed, for the
 * queue's own bounded retries: guessing here could repeat or skip a return.
 */
export async function runReturnFunds(
  raw: unknown,
  deps: ReturnFundsDeps,
): Promise<ReturnFundsOutcome> {
  const payload = parsePayload(raw);
  const scope = { principalId: payload.principalId, projectId: payload.projectId } as TenantScope;
  const network = payload.network as NetworkId;
  const mandate: MandateRef = {
    network,
    address: { network, value: payload.mandate },
    specVersion: 1,
  };
  const signal = AbortSignal.timeout(deps.timeoutMs ?? CALL_DEADLINE_MS);
  const opts = { signal, correlationId: returnFundsJobKey(payload.instanceId) };
  const { adapter, store } = deps;

  // The chain first: a return that already landed is never repeated.
  const snapshot = await adapter.readMandate({ scope, mandate }, opts);
  const { state, config } = snapshot;
  if (state.balance.amount === 0n) return { kind: 'done', reason: 'nothing_left' };
  if (!state.revoked && !state.expired) return { kind: 'done', reason: 'not_closed' };
  const now = snapshot.observedAt.time;
  if (config.proposedPrincipal !== null) {
    return held('principal_change', now + HELD_RECHECK_SECONDS);
  }
  if (!state.revoked) {
    const graceEnds = config.limits.expiresAt + SWEEP_GRACE_SECONDS;
    if (now < graceEnds) return held('grace', graceEnds);
  }
  const inflow = await store.inflow(scope, payload.instanceId, { signal });
  if (inflow === 'detected') await store.raiseInflowAlert(scope, payload.instanceId, { signal });
  if (inflow === 'detected' || inflow === 'alerted') {
    return held('third_party_inflow', now + HELD_RECHECK_SECONDS);
  }

  try {
    return { kind: 'swept', submission: await adapter.sweepToPrincipal({ scope, mandate }, opts) };
  } catch (error) {
    if (!isTransferFailed(error)) return onRefusal(error, now);
    await tellPrincipal(payload, scope, mandate, snapshot, deps, signal);
    const tries = payload.tries + 1;
    if (tries >= RETURN_FUNDS_BACKOFF.deadLetterAt) {
      await deps.alerts.deadLetter({
        scope,
        instanceId: payload.instanceId,
        reason: 'TRANSFER_FAILED',
      });
      return { kind: 'dead_letter', reason: 'TRANSFER_FAILED', tries };
    }
    return { kind: 'retry', delayMs: returnFundsDelayMs(tries), payload: { ...payload, tries } };
  }
}

// The chain moved between the read and the sweep. Its answer decides; anything else is
// not this job's to judge and goes back to the queue as it came.
function onRefusal(error: unknown, now: UnixSeconds): ReturnFundsOutcome {
  switch (refusalOf(error)) {
    case 'NOTHING_TO_SWEEP':
      return { kind: 'done', reason: 'nothing_left' };
    case 'MANDATE_ACTIVE':
      return { kind: 'done', reason: 'not_closed' };
    case 'PRINCIPAL_CHANGE_PENDING':
      return held('principal_change', now + HELD_RECHECK_SECONDS);
    case 'SWEEP_GRACE_PERIOD':
      return held('grace', now + HELD_RECHECK_SECONDS);
    default:
      throw error;
  }
}

async function tellPrincipal(
  payload: ReturnFundsPayload,
  scope: TenantScope,
  mandate: MandateRef,
  snapshot: MandateSnapshot,
  deps: ReturnFundsDeps,
  signal: AbortSignal,
): Promise<void> {
  const check = await deps.adapter.checkDestination(
    { destination: { address: snapshot.config.principal, tag: null }, asset: snapshot.asset },
    { signal, correlationId: returnFundsJobKey(payload.instanceId) },
  );
  const reason = check.receivable ? 'UNEXPLAINED' : check.reason;
  if (!(await deps.store.firstNotice(scope, payload.instanceId, reason, { signal }))) return;
  await deps.notices.cannotReceive({
    scope,
    instanceId: payload.instanceId,
    mandate,
    reason,
    fix: FIXES[reason],
  });
}

// ---------------------------------------------------------------------------
// Booking and telling the principal

/** A `swept` event as the indexer finalized it. */
export interface SweptEvent {
  readonly scope: TenantScope;
  readonly instanceId: string;
  readonly chain: string;
  readonly txHash: string;
  readonly eventIndex: bigint;
  readonly ledger: bigint;
  readonly amount: TokenAmount;
  readonly finalizedAt: Date;
}

export type BookedSweep = SweptEvent;

export interface SweepBookings {
  /**
   * Books the sweep under a unique constraint on the event's chain, transaction and
   * index: 'duplicate' when that event was booked before, by any run or trigger.
   */
  book(event: SweptEvent): Promise<'booked' | 'duplicate'>;
}

const sweptSchema = z.object({
  instanceId: z.string().min(1).max(64),
  chain: z.string().min(1).max(32),
  txHash: z.string().regex(/^[0-9a-f]{64}$/),
  eventIndex: z.bigint().nonnegative(),
  ledger: z.bigint().nonnegative(),
  amount: z.object({ amount: z.bigint().positive() }),
});

/**
 * Books one swept event, whoever triggered the sweep: this job, the principal, or a
 * stranger after the grace. The key is the event, so a replay books nothing new.
 */
export async function bookSwept(
  event: SweptEvent,
  bookings: SweepBookings,
): Promise<'booked' | 'duplicate'> {
  const checked = sweptSchema.safeParse(event);
  if (!checked.success) {
    throw new ReturnFundsPayloadError([
      ...new Set(checked.error.issues.map((issue) => issue.path.join('.'))),
    ]);
  }
  return bookings.book(event);
}

export interface FundsReturnedMessage {
  readonly principalId: Uuid;
  readonly sweeps: readonly BookedSweep[];
}

export interface SweepRunNotices {
  fundsReturned(message: FundsReturnedMessage): Promise<void>;
}

/** One message per principal for a run, however many of their mandates it swept. */
export async function notifySweepRun(
  booked: readonly BookedSweep[],
  notices: SweepRunNotices,
): Promise<void> {
  const byPrincipal = new Map<Uuid, BookedSweep[]>();
  for (const sweep of booked) {
    const list = byPrincipal.get(sweep.scope.principalId) ?? [];
    list.push(sweep);
    byPrincipal.set(sweep.scope.principalId, list);
  }
  for (const [principalId, sweeps] of byPrincipal) {
    await notices.fundsReturned({ principalId, sweeps });
  }
}
