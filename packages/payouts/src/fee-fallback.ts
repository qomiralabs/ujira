// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A fee address that cannot receive makes every execute with a fee revert, so
// recipients would go unpaid over a problem that is ours. Principal funds are not at
// risk. Those payouts are cancelled and sent again with no fee, and the fee is invoiced
// instead.
//
// A retry must never pay twice, so the new attempt goes out only once the chain proves
// the old one can never land. The job may die at any step and rerun, so every step is
// decided from the chain and from what was recorded, and never from memory.

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
  SigningRequest,
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
}

export interface FeeFallbackStore {
  /**
   * Records that UJIRA is about to cancel this attempt over its fee, before the cancel
   * goes out. A rerun finding a cancelled attempt then knows it was this and not the
   * principal changing their mind, which must never be paid again.
   */
  decideCancel(scope: TenantScope, payoutId: PayoutId, opts: StoreOptions): Promise<void>;
  cancelDecided(scope: TenantScope, payoutId: PayoutId, opts: StoreOptions): Promise<boolean>;
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

/** Signs the cancel with the key UJIRA holds, or null when only the signer's wallet can. */
export interface CancelSigner {
  sign(request: SigningRequest, opts: StoreOptions): Promise<string | null>;
}

export type FeeFallbackAdapter = Pick<
  ChainAdapter,
  | 'checkDestination'
  | 'prepareMandateAction'
  | 'proveDead'
  | 'readMandate'
  | 'status'
  | 'submitSigned'
>;

export interface FeeFallbackDeps {
  readonly adapter: FeeFallbackAdapter;
  readonly store: FeeFallbackStore;
  readonly signer: CancelSigner;
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
  /** Over for some other reason, such as a principal's cancel. Not UJIRA's to resend. */
  | { readonly kind: 'attempt_dead'; readonly proof: DeadProof }
  /** The cancel is not provably final yet. Run this again later. */
  | { readonly kind: 'cancel_pending' }
  /** Only the signer's wallet can cancel. Run this again once it has. */
  | { readonly kind: 'signature_required'; readonly request: SigningRequest }
  /** The old attempt can never land, and this one is ready to pay. */
  | { readonly kind: 'resend'; readonly request: PayRequest };

/**
 * Decides what a TRANSFER_FAILED means and carries out the fee path if it was the fee.
 * Call it again with the same input to resume. A failed read or write throws, because
 * guessing here either cancels a payout for nothing or holds up a payment.
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

  // Once decided, the address no longer matters. It may have been fixed since, but this
  // attempt was already given up on, and the new one is what pays.
  if (!(await store.cancelDecided(scope, payoutId, { signal }))) {
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
    await store.decideCancel(scope, payoutId, { signal });
  }

  // Only while it is open. A cancel on its way is not sent twice, it is waited for.
  if (onChain === 'pending' || onChain === 'approved') {
    const request = await adapter.prepareMandateAction(
      { scope, mandate, action: { op: 'cancel', payoutId }, signer: failed.signer },
      opts,
    );
    const signed = await deps.signer.sign(request, { signal });
    if (signed === null) return { kind: 'signature_required', request };
    await adapter.submitSigned(
      { scope, requestId: request.requestId, signed, correlationId },
      opts,
    );
  }

  const proof = await proveDead();
  if (proof === null) return { kind: 'cancel_pending' };
  // An approver said no while the cancel was on its way, and that answer stands.
  if (proof.kind === 'tombstone' && proof.status === 'rejected') {
    return { kind: 'attempt_dead', proof };
  }
  const request = await store.resendWithoutFee(
    { scope, payout: input.payout, failed, unpaidFee: failed.fee },
    { signal },
  );
  return { kind: 'resend', request };
}
