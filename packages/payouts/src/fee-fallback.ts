// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A fee address that cannot receive makes every execute with a fee revert, so
// recipients would go unpaid over a problem that is ours. Principal funds are not at
// risk. Those payouts are sent again with no fee, and the fee is invoiced instead.
//
// No key UJIRA holds may cancel on chain, so the failed attempt is left to lapse. A
// retry must never pay twice, so the new attempt goes out only once the chain proves
// the old one can never land, and a recipient can wait up to the mandate's payout time
// to live for that. The job may die at any step and rerun, so every step is decided from
// the chain and from what was recorded, and never from memory.

import { tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';
import type {
  ChainAdapter,
  DeadProof,
  LegKey,
  NetworkId,
  PayRequest,
  PayoutId,
  ReceivabilityReason,
  TenantScope,
  UnixSeconds,
} from '@ujira/chain-adapter';

const CALL_DEADLINE_MS = 30_000;

interface StoreOptions {
  readonly signal: AbortSignal;
}

/** Whether an error, thrown or from a batch item, is a token transfer the chain refused. */
export function isTransferFailed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, specName } = error as { code?: unknown; specName?: unknown };
  return code === 'MANDATE_RULE' && specName === 'TRANSFER_FAILED';
}

/** What a new attempt needs that only its own identity can give it. */
export interface ResendIdentity {
  readonly payoutId: PayoutId;
  /** One per leg of the failed request, in order. */
  readonly legKeys: readonly LegKey[];
  readonly deadline: UnixSeconds;
  /** Attestations name the leg keys, so the old ones cannot be carried over. */
  readonly attestations: PayRequest['attestations'];
}

/** The failed request again with no fee, under the new attempt's identity. */
export function zeroFeeRequest(failed: PayRequest, identity: ResendIdentity): PayRequest {
  const { legKeys } = identity;
  if (legKeys.length !== failed.legs.length) {
    throw new RangeError('a resend needs one new leg key per leg');
  }
  return {
    ...failed,
    payoutId: identity.payoutId,
    attempt: failed.attempt + 1,
    deadline: identity.deadline,
    attestations: identity.attestations,
    fee: tokenAmount(0n, failed.fee.asset, failed.fee.chain),
    legs: failed.legs.map((leg, i) => ({ ...leg, legKey: legKeys[i] ?? leg.legKey })),
  };
}

export interface ZeroFeeResend {
  readonly scope: TenantScope;
  /** UJIRA's payout, which outlives its attempts: the invoice item is per this. */
  readonly payout: string;
  readonly failed: PayRequest;
  /** The fee the chain did not take, for invoicing. */
  readonly unpaidFee: TokenAmount;
  /** Why the failed attempt can never land. Nothing frees a payout for a new one without it. */
  readonly proof: DeadProof;
}

export interface FeeFallbackStore {
  /**
   * Records that this attempt is to be sent again with no fee once it has lapsed. The
   * decision is not reopened: if the address is fixed during the wait, the fee can still
   * land on this attempt until it lapses, and after that this one is given up on.
   */
  decideResend(scope: TenantScope, payoutId: PayoutId, opts: StoreOptions): Promise<void>;
  resendDecided(scope: TenantScope, payoutId: PayoutId, opts: StoreOptions): Promise<boolean>;
  /**
   * In one transaction: the new attempt, and the one invoice item of the payout, enforced
   * by a unique constraint. The same answer on a rerun. Together, so a payout can never
   * carry an invoice with its fee also going out on chain. An invoice run bills an item
   * only once its payout is paid.
   */
  resendWithoutFee(resend: ZeroFeeResend, opts: StoreOptions): Promise<PayRequest>;
  /** Alerts operations the first time, and does nothing until it is cleared. */
  raiseAddressAlarm(
    network: NetworkId,
    reason: ReceivabilityReason,
    opts: StoreOptions,
  ): Promise<void>;
  clearAddressAlarm(network: NetworkId, opts: StoreOptions): Promise<void>;
}

export type FeeFallbackAdapter = Pick<
  ChainAdapter,
  'checkDestination' | 'proveDead' | 'readMandate' | 'status'
>;

export interface FeeFallbackDeps {
  readonly adapter: FeeFallbackAdapter;
  readonly store: FeeFallbackStore;
  readonly timeoutMs?: number;
}

export interface FeeTransferFailure {
  readonly payout: string;
  readonly failed: PayRequest;
  readonly correlationId: string;
}

export type FeeFallbackOutcome =
  /** Not the fee address's doing. The normal leg fallback decides what happens. */
  | { readonly kind: 'leg_fallback' }
  /** It landed after all. The payout is paid, and nothing may go out again. */
  | { readonly kind: 'already_landed' }
  /** Over by someone's decision, such as a principal's cancel. Not UJIRA's to resend. */
  | { readonly kind: 'attempt_dead'; readonly proof: DeadProof }
  /** Decided, and the attempt could still land until it lapses. Run this again later. */
  | { readonly kind: 'awaiting_lapse' }
  /** The old attempt can never land, and this one is ready to pay. */
  | { readonly kind: 'resend'; readonly request: PayRequest };

/**
 * Decides what a TRANSFER_FAILED means and carries out the fee path if it was the fee.
 * Call it again with the same input to resume. A failed read or write throws, because
 * guessing here either gives up a fee for nothing or holds up a payment.
 */
export async function onTransferFailed(
  input: FeeTransferFailure,
  deps: FeeFallbackDeps,
): Promise<FeeFallbackOutcome> {
  const { failed, correlationId } = input;
  const { adapter, store } = deps;
  const { scope, mandate, payoutId } = failed;
  if (failed.fee.amount === 0n) return { kind: 'leg_fallback' };

  const signal = AbortSignal.timeout(deps.timeoutMs ?? CALL_DEADLINE_MS);
  const opts = { signal, correlationId };
  const proveDead = () =>
    adapter.proveDead({ scope, mandate, payoutId, deadline: failed.deadline }, opts);

  const legs = failed.legs.map((leg) => leg.legKey);
  const { onChain } = await adapter.status({ scope, mandate, payoutId, legs }, opts);
  if (onChain === 'executed') return { kind: 'already_landed' };

  if (!(await store.resendDecided(scope, payoutId, { signal }))) {
    const snapshot = await adapter.readMandate({ scope, mandate }, opts);
    const check = await adapter.checkDestination(
      {
        destination: { address: snapshot.config.feeAddress, tag: null },
        asset: snapshot.asset,
        amount: failed.fee,
      },
      opts,
    );
    if (check.receivable) {
      await store.clearAddressAlarm(mandate.network, { signal });
    } else {
      await store.raiseAddressAlarm(mandate.network, check.reason, { signal });
    }
    const dead = await proveDead();
    if (dead !== null) return { kind: 'attempt_dead', proof: dead };
    if (check.receivable) return { kind: 'leg_fallback' };
    await store.decideResend(scope, payoutId, { signal });
    return { kind: 'awaiting_lapse' };
  }

  const proof = await proveDead();
  if (proof === null) return { kind: 'awaiting_lapse' };
  // UJIRA never cancels, so a tombstone is a person's decision about this payout: a
  // principal's cancel or an approver's rejection. Neither may be undone by paying it.
  if (proof.kind === 'tombstone') return { kind: 'attempt_dead', proof };
  const request = await store.resendWithoutFee(
    { scope, payout: input.payout, failed, unpaidFee: failed.fee, proof },
    { signal },
  );
  return { kind: 'resend', request };
}
