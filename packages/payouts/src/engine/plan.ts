// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Everything decided before an attempt exists: what to ask the router, what the
// minimums say about its answer, and what the attempt will carry. All of it can reach
// a network, so none of it runs inside a transaction. Recording the plan is one short
// transaction at the end, which is what every rerun finds.

import type {
  AttestationInput,
  CallOptions,
  ChainAdapterRegistry,
  CountryCode,
  NetworkId,
  PayoutLegInput,
  Quote,
  SignerRef,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { isChainAdapterError } from '@ujira/chain-adapter';
import { allocate, type Money, type TokenAmount } from '@ujira/core';
import {
  AmountBelowMinimumError,
  checkMinimum,
  fundingHolds,
  MinimumNotComparableError,
  payoutAttempts,
  payoutEngine,
  payoutMethods,
  payoutMinimums,
  payouts,
  projects,
  recipients,
  type CashoutCostBearer,
  type Database,
  type NewPayoutLeg,
  type Payout,
  type PayoutAttempt,
  type PayoutMinimumContext,
  type PayoutMinimumMethod,
  type ProjectContext,
  type TenantTx,
} from '@ujira/db';
import type {
  PreviousAttempt,
  RouteDeps,
  RouteLeg,
  RouteRequest,
  RoutedOutcome,
} from '@ujira/router';

import { AMOUNT_BELOW_MINIMUM, RetryableJobError, TerminalRefusal } from '../worker/errors.js';
import type { Alert } from '../worker/handlers.js';
import { legKeyOf, onChainPayoutId } from './ids.js';

// How long an attempt may take before it can be proven dead.
export const ATTEMPT_TTL_SECONDS = 3_600;

export const TRANSFER_FAILED = 'TRANSFER_FAILED';

// Another job moved the row first, so this run has nothing left to say.
export class LostRace extends Error {
  override readonly name = 'LostRace';
}

export interface AttestationRequest {
  readonly scope: TenantScope;
  readonly payoutId: string;
  readonly attemptNumber: number;
  readonly network: NetworkId;
  readonly legs: readonly PayoutLegInput[];
}

// A share of a payout on one method. The first is the recipient's main method.
export interface LegShare {
  readonly method: RouteLeg['method'];
  readonly currency: RouteLeg['currency'];
  readonly weight: bigint;
}

export interface EngineDeps {
  readonly db: Database;
  readonly adapters: ChainAdapterRegistry;
  readonly routing: RouteDeps;
  // The agent that requests the payout.
  readonly signerFor: (scope: TenantScope, network: NetworkId) => SignerRef;
  // One per leg, or none in allowlist mode. Asked once per attempt before it is
  // requested, so a new attempt has fresh ones, and an attempt lives no longer than
  // its earliest one.
  readonly attestationsFor: (req: AttestationRequest) => Promise<{
    readonly attestations: readonly AttestationInput[];
    readonly earliestValidUntil: UnixSeconds | null;
  }>;
  // Sends the cancel for a payout whose transfer failed, which the agent that requested it
  // may do. The tombstone it leaves is the proof that frees the next attempt.
  readonly cancelOnChain: (
    req: {
      readonly scope: TenantScope;
      readonly mandateInstanceId: string;
      readonly network: NetworkId;
      readonly payoutId: PayoutId;
    },
    opts: CallOptions,
  ) => Promise<void>;
  // The recipient's split. Absent or empty pays the main method alone.
  readonly splitOf?: (context: ProjectContext, payout: Payout) => Promise<readonly LegShare[]>;
  readonly minimumContext?: (
    method: PayoutMinimumMethod,
    network: NetworkId,
  ) => PayoutMinimumContext;
  readonly alert: Alert;
  // The chain's clock in milliseconds. Decides deadlines, never when a job runs.
  readonly now?: () => number;
}

export const scopeOf = (context: ProjectContext): TenantScope => ({
  principalId: context.principalId as Uuid,
  projectId: context.projectId as Uuid,
});

export const nowOf = (deps: EngineDeps): number =>
  deps.now === undefined ? Date.now() : deps.now();

// A failure from the adapter that another try might clear, or one that will not.
function classified(error: unknown): RetryableJobError | undefined {
  if (!isChainAdapterError(error) || !error.retryable) return undefined;
  return new RetryableJobError(error.code, { cause: error });
}

interface Grossed {
  readonly total: TokenAmount;
  readonly quote: Quote;
}

// Principal mode: the recipient must receive exactly the local amount, so it is quoted
// by what it buys, and what it sells becomes the total. The anchor's fee and the rate
// are inside that amount and never touch the fee leg. A rail the network cannot serve
// right now is never asked, which is how a recipient with no anchor enabled is refused
// at routing rather than quoted.
async function grossUp(
  deps: EngineDeps,
  scope: TenantScope,
  payout: Payout,
  country: string,
  opts: CallOptions,
): Promise<Grossed | undefined> {
  const asked = payout.requested as Money;
  const config = deps.routing.config();
  const corridor = config.corridors.find(
    (c) =>
      c.enabled &&
      c.country === country &&
      c.method === payout.method &&
      c.currency === asked.currency,
  );
  if (corridor === undefined) return undefined;
  const ordered = [...corridor.candidates].sort((a, b) => a.priority - b.priority);
  for (const candidate of ordered) {
    const rail = config.rails.find((r) => r.id === candidate.rail && r.enabled);
    if (rail === undefined) continue;
    const adapter = deps.adapters.list().find((a) => a.network === rail.network);
    if (adapter === undefined) continue;
    const capabilities = adapter.capabilities();
    const capable = capabilities.rails.find((r) => r.rail === rail.rail);
    const asset = capabilities.settlementAssets[0];
    if (capable?.enabled !== true || asset === undefined) continue;
    if (!capable.deliveryCurrencies.includes(asked.currency)) continue;
    try {
      const quote = await adapter.quote(
        {
          scope,
          rail: rail.rail,
          country: country as CountryCode,
          sell: { asset },
          buy: { currency: asked.currency },
          amount: { side: 'buy', value: asked },
          firm: true,
        },
        opts,
      );
      return { total: quote.sell, quote };
    } catch (error) {
      const retry = classified(error);
      if (retry !== undefined) throw retry;
      if (!isChainAdapterError(error)) throw error;
      // This rail will not quote it. Another candidate might.
    }
  }
  return undefined;
}

// Splits with the remainder on the first leg, so the legs always sum to the total.
export function splitLegs(
  total: TokenAmount,
  shares: readonly LegShare[],
  main: RouteLeg,
): readonly RouteLeg[] {
  if (shares.length < 2) return [main];
  const amounts = allocate(
    total,
    shares.map((share) => share.weight),
  );
  const legs = shares.flatMap((share, index) => {
    const amount = amounts[index];
    return amount === undefined ? [] : [{ method: share.method, currency: share.currency, amount }];
  });
  // A leg of nothing cannot be paid at all, so the split does not stand.
  return legs.some((leg) => leg.amount.amount <= 0n) ? [main] : legs;
}

export interface RoutePlan {
  readonly request: RouteRequest;
  // The firm quote that set a principal mode total.
  readonly firm?: Quote;
  readonly bearer: CashoutCostBearer;
  readonly attempts: readonly PayoutAttempt[];
}

// Rebuilt the same way for the first route, a new attempt and a release from hold.
// Undefined when a principal mode amount cannot be priced anywhere, which is no route.
export async function routePlan(
  deps: EngineDeps,
  context: ProjectContext,
  payout: Payout,
  signal: AbortSignal,
): Promise<RoutePlan | undefined> {
  const found = await deps.db.tenant(context).transaction(async (tx) => ({
    recipient: await recipients.get(tx, payout.recipientId),
    settings: await projects.settings(tx),
    attempts: await payoutAttempts.forPayout(tx, payout.id),
    refusal: await payoutEngine.refusalCode(tx, payout.id),
  }));
  if (found.recipient === undefined) throw new Error('a payout names no recipient');
  const { country } = found.recipient;
  const scope = scopeOf(context);
  const opts: CallOptions = { signal, correlationId: payout.id };
  const grossed =
    payout.requested.kind === 'fiat'
      ? await grossUp(deps, scope, payout, country, opts)
      : undefined;
  if (payout.requested.kind === 'fiat' && grossed === undefined) return undefined;
  const total = grossed?.total ?? (payout.requested as TokenAmount);
  const main: RouteLeg = {
    method: payout.method as RouteLeg['method'],
    currency:
      payout.requested.kind === 'fiat'
        ? payout.requested.currency
        : deliveryCurrency(deps, country, payout.method, total),
    amount: total,
  };
  // A transfer that failed is a leg that cannot be paid, so the next attempt goes to the
  // main method alone.
  const shares =
    payout.requested.kind === 'token' &&
    deps.splitOf !== undefined &&
    found.refusal !== TRANSFER_FAILED
      ? await deps.splitOf(context, payout)
      : [];
  const previous = found.attempts.at(-1);
  return {
    request: {
      scope,
      mandateId: payout.mandateId as Uuid,
      recipientId: payout.recipientId as Uuid,
      country,
      total,
      legs: splitLegs(total, shares, main),
      chainFallback: found.settings?.chainFallback ?? 'off',
      correlationId: payout.id,
      ...(previous === undefined ? {} : { previousAttempt: previousOf(previous) }),
    },
    ...(grossed === undefined ? {} : { firm: grossed.quote }),
    bearer: payout.cashoutCostBearer as CashoutCostBearer,
    attempts: found.attempts,
  };
}

// The corridor says what a method pays out in. With none, the amount's own unit, and
// the router then finds nothing for it.
function deliveryCurrency(
  deps: EngineDeps,
  country: string,
  method: string,
  total: TokenAmount,
): RouteLeg['currency'] {
  const corridor = deps.routing
    .config()
    .corridors.find((c) => c.enabled && c.country === country && c.method === method);
  return corridor?.currency ?? total.asset;
}

// A proof comes back from JSON with its ledger number as a string. An attempt still live
// pins the payout to its network.
function previousOf(previous: PayoutAttempt): PreviousAttempt {
  if (previous.status !== 'dead') {
    return { state: 'live', network: previous.network as NetworkId };
  }
  const proof = previous.deadProof as PreviousDeadProof;
  return {
    state: 'dead',
    network: previous.network as NetworkId,
    proof: { ...proof, at: { ...proof.at, ledgerOrBlock: BigInt(proof.at.ledgerOrBlock) } },
  } as PreviousAttempt;
}

interface PreviousDeadProof {
  readonly at: { readonly ledgerOrBlock: string };
}

// True when every leg meets the largest of the method's floor, the rail's own minimum,
// the project's, and the break-even total. Checked on what is actually sent, so in
// principal mode on the grossed-up leg.
export async function legsMeetMinimums(
  deps: EngineDeps,
  context: ProjectContext,
  route: RoutedOutcome,
): Promise<boolean> {
  const minimums = await deps.db.tenant(context).transaction(async (tx) => payoutMinimums.list(tx));
  const adapter = deps.adapters.get(route.network);
  for (const leg of route.legs) {
    const method = leg.method;
    const capable = adapter.capabilities().rails.find((rail) => rail.rail === leg.rail);
    const minimum: PayoutMinimumContext = {
      ...(capable?.minLeg === undefined
        ? {}
        : {
            anchorMinimum: {
              amount: capable.minLeg.amount,
              currency: capable.minLeg.asset,
              scale: capable.minLeg.scale,
            },
          }),
      ...deps.minimumContext?.(method, route.network),
    };
    try {
      checkMinimum(
        method,
        { amount: leg.amount.amount, currency: leg.amount.asset, scale: leg.amount.scale },
        minimums.filter((row) => row.method === method).map((row) => row.minimum),
        minimum,
      );
    } catch (error) {
      if (error instanceof AmountBelowMinimumError) return false;
      // No rate right now to compare with, which another try may have.
      if (error instanceof MinimumNotComparableError) {
        throw new RetryableJobError('MINIMUM_NOT_COMPARABLE', { cause: error });
      }
      throw error;
    }
  }
  return true;
}

export interface AttemptPlan {
  readonly route: RoutedOutcome;
  readonly attemptNumber: number;
  readonly fee: TokenAmount;
  readonly deadline: Date;
  readonly legs: readonly NewPayoutLeg[];
}

// A firm quote on what a cash-out leg sells, in recipient mode. A leg straight to a
// wallet delivers the token itself and has nothing to record.
async function deliveryQuote(
  deps: EngineDeps,
  plan: RoutePlan,
  route: RoutedOutcome,
  leg: RoutedOutcome['legs'][number],
  signal: AbortSignal,
): Promise<Quote | undefined> {
  if (plan.firm !== undefined) return plan.firm;
  if (leg.quote?.source === 'sep38') return leg.quote;
  if (leg.currency === leg.amount.asset) return undefined;
  try {
    return await deps.adapters.get(route.network).quote(
      {
        scope: plan.request.scope,
        rail: leg.rail,
        country: plan.request.country as CountryCode,
        sell: { asset: leg.amount.asset },
        buy: { currency: leg.currency },
        amount: { side: 'sell', value: leg.amount },
        firm: true,
        recipientMethodId: leg.recipientMethodId,
      },
      { signal, correlationId: plan.request.correlationId },
    );
  } catch (error) {
    const retry = classified(error);
    if (retry !== undefined) throw retry;
    throw error;
  }
}

function legInputsOf(
  route: RoutedOutcome,
  onChainId: ReturnType<typeof onChainPayoutId>,
): readonly PayoutLegInput[] {
  return route.legs.map((leg, index) => ({
    index,
    legKey: legKeyOf(onChainId, index),
    rail: leg.rail,
    recipientMethodId: leg.recipientMethodId,
    amount: leg.amount,
    deliveryCurrency: leg.currency,
    ...(leg.quote === undefined ? {} : { quoteId: leg.quote.id }),
  }));
}

// The legs a route comes to, with what each cash-out will deliver.
export async function plannedLegs(
  deps: EngineDeps,
  context: ProjectContext,
  plan: RoutePlan,
  route: RoutedOutcome,
  signal: AbortSignal,
): Promise<readonly NewPayoutLeg[]> {
  const methods = await deps.db
    .tenant(context)
    .transaction(async (tx) =>
      Promise.all(route.legs.map(async (leg) => payoutMethods.get(tx, leg.recipientMethodId))),
    );
  const legs: NewPayoutLeg[] = [];
  for (const [index, leg] of route.legs.entries()) {
    const method = methods[index];
    if (method === undefined) throw new Error('a routed leg names no payout method');
    const quote = await deliveryQuote(deps, plan, route, leg, signal);
    const anchorFee = quote?.fees.find((fee) => fee.kind === 'anchor')?.amount;
    legs.push({
      payoutMethodId: method.id,
      method: leg.method,
      rail: leg.rail,
      destinationAddress: method.destinationAddress,
      destinationTag: method.destinationTag,
      amount: leg.amount.amount,
      ...(anchorFee?.kind === 'token' ? { fee: anchorFee.amount } : {}),
      ...(quote === undefined
        ? {}
        : {
            delivery: {
              receive: quote.buy,
              fxNumerator: quote.price.numerator,
              fxDenominator: quote.price.denominator,
              costBearer: plan.bearer,
              quoteId: quote.id,
            },
          }),
    });
  }
  return legs;
}

// What one attempt will carry. The take is on the total in either mode, so in principal
// mode on the grossed-up total.
export async function attemptPlan(
  deps: EngineDeps,
  context: ProjectContext,
  plan: RoutePlan,
  route: RoutedOutcome,
  key: string,
  signal: AbortSignal,
): Promise<AttemptPlan> {
  const attemptNumber = plan.attempts.length + 1;
  const onChainId = onChainPayoutId(context, key, attemptNumber);
  const { earliestValidUntil } = await deps.attestationsFor({
    scope: plan.request.scope,
    payoutId: onChainId,
    attemptNumber,
    network: route.network,
    legs: legInputsOf(route, onChainId),
  });
  const ttlEnd = nowOf(deps) + ATTEMPT_TTL_SECONDS * 1_000;
  const attestEnd = earliestValidUntil === null ? ttlEnd : Number(earliestValidUntil) * 1_000;
  const legs = await plannedLegs(deps, context, plan, route, signal);
  const total = plan.request.total;
  return {
    route,
    attemptNumber,
    fee: deps.routing.feeFor(route.network, total),
    deadline: new Date(Math.min(ttlEnd, attestEnd)),
    legs,
  };
}

// In one transaction: the holds gone, the payout routed, its total set and the attempt
// with its legs. Of two jobs that reach here, the second finds no holds, or the live
// attempt the first wrote, and rolls back.
export async function recordAttempt(
  tx: TenantTx,
  context: ProjectContext,
  payout: Payout,
  plan: AttemptPlan,
  total: TokenAmount,
  key: string,
): Promise<PayoutAttempt> {
  if (payout.statusReason === 'awaiting_funding') {
    if ((await fundingHolds.release(tx, payout.id)) === 0) throw new LostRace();
  }
  if (payout.status === 'received') {
    const moved = await payouts.transition(tx, payout.id, { from: 'received', to: 'routed' });
    if (moved === undefined) throw new LostRace();
  }
  await payoutEngine.setTotal(tx, payout.id, total);
  const attempt = await payoutAttempts.create(tx, {
    payoutId: payout.id,
    mandateInstanceId: plan.route.mandateInstanceId,
    network: plan.route.network,
    total,
    fee: plan.fee,
    deadline: plan.deadline,
    onChainPayoutId: onChainPayoutId(context, key, plan.attemptNumber),
    legs: plan.legs,
  });
  // The id above named this number. Had another attempt slipped in, the id would be
  // wrong, so this rolls back and the rerun reads again.
  if (attempt.attemptNumber !== plan.attemptNumber) throw new LostRace();
  return attempt;
}

export function belowMinimum(): TerminalRefusal {
  return new TerminalRefusal(AMOUNT_BELOW_MINIMUM);
}

// The main method alone, for a split that does not stand.
export function collapsed(plan: RoutePlan, total: TokenAmount): RouteRequest {
  const main = plan.request.legs[0];
  if (main === undefined) throw new Error('a route plan has at least one leg');
  return { ...plan.request, legs: [{ ...main, amount: total }] };
}
