// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A receipt is issued once, when a payout reaches paid, and must match the
// chain exactly, so it is checked against the chain before anything is
// stored. A correction is a new revision, never an edit: the store's only
// write is an insert, and it is keyed on tenant, payout and revision, which
// is what makes a repeated or racing job safe.
//
// This package does no I/O of its own. The store, the paid payout and the
// alerts are ports, implemented over the db package's repository layer when
// the receipts tables exist, and the chain is reached only through the
// adapter.

import { createHash } from 'node:crypto';

import type {
  CallOptions,
  ChainAdapter,
  ChainReceipt,
  MandateRef,
  NetworkId,
  PayoutId,
  TenantScope,
} from '@ujira/chain-adapter';
import type { Money, TokenAmount } from '@ujira/core';
import { z } from 'zod';

import { withDeadline } from './deadline.js';
import { documentSha256 } from './document.js';
import {
  ReceiptChainAbortedError,
  ReceiptChainTimeoutError,
  ReceiptNotIssuedError,
  ReceiptNotPaidError,
  ReceiptTenantMismatchError,
  ReceiptUnverifiedError,
} from './errors.js';
import { buildReceipt } from './model.js';
import type {
  PayoutMethod,
  Receipt,
  ReceiptDestination,
  ReceiptFee,
  ReceiptInput,
} from './model.js';

/** A leg as the payout records it. What it sent on chain comes from the chain. */
export interface PaidLeg {
  readonly index: number;
  readonly method: PayoutMethod;
  readonly destination: ReceiptDestination;
  readonly received: Money | null;
  readonly railFee: TokenAmount;
}

/** A payout that reached paid, as the payouts package records it. */
export interface PaidPayout {
  readonly scope: TenantScope;
  readonly id: string;
  /** The ID the mandate knows the payout by. */
  readonly chainPayoutId: PayoutId;
  readonly taskId: string | null;
  readonly mandate: { readonly id: string; readonly name: string; readonly ref: MandateRef };
  readonly recipientRef: string;
  readonly requested: Money;
  readonly total: TokenAmount;
  readonly fee: ReceiptFee;
  readonly legs: readonly PaidLeg[];
}

/** A receipt as stored, with the hash of the document it was stored under. */
export interface StoredReceipt {
  readonly payoutId: string;
  readonly receipt: Receipt;
  readonly documentSha256: string;
}

/**
 * Implemented in the db package's repository layer. Tables are append only,
 * so there is no update and no delete here.
 */
export interface ReceiptIssueStore {
  /** The highest revision of a payout's receipt for this tenant, or null. */
  latest(scope: TenantScope, payoutId: string): Promise<StoredReceipt | null>;
  /** Unique on tenant, payout and revision: 'conflict' when that revision exists. */
  insert(scope: TenantScope, stored: StoredReceipt): Promise<'inserted' | 'conflict'>;
}

export type ReceiptBlockReason =
  | 'not_found'
  | 'reorged'
  | 'mismatch'
  | 'outside_rpc_retention'
  /** The chain's receipt verified, but says something other than the payout does. */
  | 'payout_disagrees';

export interface ReceiptAlerts {
  /** A paid payout has no receipt, and someone has to look at why. */
  receiptBlocked(e: {
    readonly scope: TenantScope;
    readonly payoutId: string;
    readonly network: NetworkId;
    readonly reason: ReceiptBlockReason;
    readonly correlationId: string;
  }): void;
}

export interface ReceiptIssuePorts {
  readonly store: ReceiptIssueStore;
  /** The payout if it has reached paid, for this tenant, otherwise null. */
  paidPayout(scope: TenantScope, payoutId: string): Promise<PaidPayout | null>;
  /** The adapter for a network. Throws the registry's error when there is none. */
  adapter(network: NetworkId): Pick<ChainAdapter, 'receipt' | 'verifyReceipt'>;
  readonly alerts: ReceiptAlerts;
  readonly clock: { nowSeconds(): bigint };
  /** Deadline for each chain call. */
  readonly chainTimeoutMs: number;
}

export type ReceiptIssueOutcome =
  | { readonly status: 'issued'; readonly stored: StoredReceipt }
  | { readonly status: 'already_issued'; readonly stored: StoredReceipt | null }
  | { readonly status: 'blocked'; readonly reason: ReceiptBlockReason };

const NUMBER_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The number of one revision of one payout's receipt. Derived rather than
 * drawn, so a retried job asks to insert the same receipt it tried before.
 */
export function receiptNumberFor(scope: TenantScope, payoutId: string, revision: number): string {
  const digest = createHash('sha256')
    .update(`${scope.principalId}:${scope.projectId}:${payoutId}:${String(revision)}`)
    .digest();
  const chars = Array.from(digest.subarray(0, 12), (byte) =>
    NUMBER_ALPHABET.charAt(byte % NUMBER_ALPHABET.length),
  );
  return `R-${chars.join('')}`;
}

function sameTenant(a: TenantScope, b: TenantScope): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId;
}

// A port answering for another tenant is a bug that must never reach a
// receipt, whichever store is behind it.
function checked<T extends { readonly receipt: Receipt } | null>(scope: TenantScope, stored: T): T {
  if (
    stored !== null &&
    (stored.receipt.principalId !== scope.principalId ||
      stored.receipt.projectId !== scope.projectId)
  ) {
    throw new ReceiptTenantMismatchError('the store answered for another tenant');
  }
  return stored;
}

function isoSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

function chainCall<T>(
  ports: ReceiptIssuePorts,
  opts: CallOptions,
  call: (opts: CallOptions) => Promise<T>,
): Promise<T> {
  return withDeadline(
    (signal) => call({ correlationId: opts.correlationId, signal }),
    ports.chainTimeoutMs,
    opts.signal,
    {
      timeout: () => new ReceiptChainTimeoutError('the chain did not answer in time'),
      aborted: (reason) =>
        new ReceiptChainAbortedError('the chain call was aborted by the caller', { cause: reason }),
    },
  );
}

/** Whether what verified on chain is what the payout says happened. */
function agrees(payout: PaidPayout, onChain: ChainReceipt): boolean {
  // One settlement token today, so the types say these always match. Read as
  // plain strings, the check still guards a second token when one is added.
  const [chainAsset, paidAsset]: string[] = [onChain.total.asset, payout.total.asset];
  if (
    onChain.payoutId !== payout.chainPayoutId ||
    onChain.network !== payout.mandate.ref.network ||
    onChain.mandate.address.value !== payout.mandate.ref.address.value ||
    onChain.total.amount !== payout.total.amount ||
    chainAsset !== paidAsset ||
    onChain.legs.length !== payout.legs.length
  ) {
    return false;
  }
  return payout.legs.every((leg) => {
    const chainLeg = onChain.legs.find((candidate) => candidate.index === leg.index);
    return chainLeg !== undefined && (chainLeg.tag ?? null) === leg.destination.tag;
  });
}

function inputFor(payout: PaidPayout, onChain: ChainReceipt, issuedAt: string): ReceiptInput {
  return {
    principalId: payout.scope.principalId,
    projectId: payout.scope.projectId,
    receiptNumber: receiptNumberFor(payout.scope, payout.id, 1),
    revision: 1,
    supersedes: null,
    issuedAt,
    payoutId: payout.id,
    taskId: payout.taskId,
    mandate: { id: payout.mandate.id, name: payout.mandate.name },
    recipientRef: payout.recipientRef,
    network: onChain.network,
    receiptRef: onChain.ref,
    requested: payout.requested,
    total: payout.total,
    fee: payout.fee,
    feeRefunds: [],
    legs: payout.legs.map((leg) => ({
      index: leg.index,
      method: leg.method,
      destination: leg.destination,
      // The amount each leg sent is the chain's, not the payout's. Every leg
      // of a payout settles in the one execution the chain receipt names.
      amount: onChain.legs.find((chainLeg) => chainLeg.index === leg.index)?.amount ?? payout.total,
      received: leg.received,
      railFee: leg.railFee,
      receiptRef: onChain.ref,
    })),
  };
}

function storedOf(payoutId: string, receipt: Receipt): StoredReceipt {
  return Object.freeze({ payoutId, receipt, documentSha256: documentSha256(receipt) });
}

/**
 * Issues revision 1 for a paid payout. A payout that already has a receipt
 * answers 'already_issued' and touches nothing. A receipt the chain does not
 * confirm, or that disagrees with the payout, is not issued: it answers
 * 'blocked' and alerts. Adapter errors pass through unchanged, so a job can
 * apply their retry rules. Throws ReceiptNotPaidError when the payout has not
 * reached paid, and ReceiptChainTimeoutError at the deadline.
 */
export async function issueReceipt(
  ports: ReceiptIssuePorts,
  scope: TenantScope,
  payoutId: string,
  opts: CallOptions,
): Promise<ReceiptIssueOutcome> {
  const existing = checked(scope, await ports.store.latest(scope, payoutId));
  if (existing !== null) return { status: 'already_issued', stored: existing };

  const payout = await ports.paidPayout(scope, payoutId);
  if (payout === null) throw new ReceiptNotPaidError('the payout has not reached paid');
  if (!sameTenant(payout.scope, scope)) {
    throw new ReceiptTenantMismatchError('the payout belongs to another tenant');
  }

  const { network } = payout.mandate.ref;
  const adapter = ports.adapter(network);
  const blocked = (reason: ReceiptBlockReason): ReceiptIssueOutcome => {
    ports.alerts.receiptBlocked({
      scope,
      payoutId,
      network,
      reason,
      correlationId: opts.correlationId,
    });
    return { status: 'blocked', reason };
  };

  const chainReceipt = await chainCall(ports, opts, (o) =>
    adapter.receipt({ scope, mandate: payout.mandate.ref, payoutId: payout.chainPayoutId }, o),
  );
  const verification = await chainCall(ports, opts, (o) =>
    adapter.verifyReceipt(chainReceipt.ref, o),
  );
  if (!verification.ok) return blocked(verification.reason);
  if (!agrees(payout, verification.receipt)) return blocked('payout_disagrees');

  const receipt = buildReceipt(
    inputFor(payout, verification.receipt, isoSeconds(ports.clock.nowSeconds())),
  );
  const stored = storedOf(payoutId, receipt);
  const written = await ports.store.insert(scope, stored);
  if (written === 'conflict') {
    return {
      status: 'already_issued',
      stored: checked(scope, await ports.store.latest(scope, payoutId)),
    };
  }
  return { status: 'issued', stored };
}

export interface ReceiptCorrectionRequest {
  readonly scope: TenantScope;
  readonly payoutId: string;
  /** The revision this one corrects. Makes a repeated correction a no-op. */
  readonly supersedesRevision: number;
  /** The fee returned on a refunded part, and the transfer that returned it. */
  readonly feeRefund: { readonly amount: TokenAmount; readonly receiptRef: string };
}

/**
 * Issues the next revision of a receipt, which references the one it replaces
 * by number and document hash and leaves it as it is. A repeat of a correction
 * already made answers 'already_issued'. Throws ReceiptNotIssuedError when
 * there is no such revision to correct, and ReceiptInvalidError when the
 * refund breaks the model's rules, such as refunding more than the fee.
 */
export async function issueReceiptCorrection(
  ports: Pick<ReceiptIssuePorts, 'store' | 'clock'>,
  req: ReceiptCorrectionRequest,
): Promise<ReceiptIssueOutcome> {
  const { scope, payoutId, supersedesRevision, feeRefund } = req;
  const latest = checked(scope, await ports.store.latest(scope, payoutId));
  if (latest === null) throw new ReceiptNotIssuedError('the payout has no receipt to correct');
  if (latest.receipt.revision > supersedesRevision) {
    return { status: 'already_issued', stored: latest };
  }
  if (latest.receipt.revision < supersedesRevision) {
    throw new ReceiptNotIssuedError('the revision to correct has not been issued');
  }
  const previous = latest.receipt;
  const revision = previous.revision + 1;
  const receipt = buildReceipt({
    principalId: previous.principalId,
    projectId: previous.projectId,
    receiptNumber: receiptNumberFor(scope, payoutId, revision),
    revision,
    supersedes: {
      receiptNumber: previous.receiptNumber,
      documentSha256: latest.documentSha256,
    },
    issuedAt: isoSeconds(ports.clock.nowSeconds()),
    payoutId: previous.payoutId,
    taskId: previous.taskId,
    mandate: previous.mandate,
    recipientRef: previous.recipientRef,
    network: previous.network,
    receiptRef: previous.receiptRef,
    requested: previous.requested,
    total: previous.total,
    fee: previous.fee,
    feeRefunds: [...previous.feeRefunds, feeRefund],
    legs: previous.legs,
  });
  const stored = storedOf(payoutId, receipt);
  const written = await ports.store.insert(scope, stored);
  if (written === 'conflict') {
    return {
      status: 'already_issued',
      stored: checked(scope, await ports.store.latest(scope, payoutId)),
    };
  }
  return { status: 'issued', stored };
}

/** The queue task. A colon task name, as the worker's other tasks use. */
export const RECEIPT_ISSUE_TASK = 'receipt:issue';

/**
 * Bounded retries for the job. A receipt the chain has not confirmed may be
 * confirmed a little later, but not forever; the worker's dead letter path
 * takes it from here, and the alert has already gone out.
 */
export const RECEIPT_ISSUE_MAX_ATTEMPTS = 10;

// Worth another try: the chain may simply not have caught up. A receipt that
// mismatches or disagrees will not change, so retrying only repeats the alert.
const RETRY_REASONS: ReadonlySet<ReceiptBlockReason> = new Set(['not_found', 'reorged']);

const IssuePayload = z.strictObject({
  principalId: z.uuid(),
  projectId: z.uuid(),
  payoutId: z.uuid(),
});

/** The job key: one issue job per payout, so a repeated paid event adds nothing. */
export function receiptIssueJobKey(payoutId: string): string {
  return `${RECEIPT_ISSUE_TASK}:${payoutId}`;
}

/**
 * The handler for the receipt:issue job. A malformed payload, or a block that
 * might clear, throws so that the queue's bounded retries apply. A block that
 * cannot clear finishes the job, because the alert is what acts on it.
 */
export function receiptIssueTask(
  ports: ReceiptIssuePorts,
): (payload: unknown, helpers: { readonly correlationId: string }) => Promise<void> {
  return async (payload, helpers) => {
    const parsed = IssuePayload.safeParse(payload);
    if (!parsed.success) throw new ReceiptUnverifiedError('the job payload is not valid');
    const { principalId, projectId, payoutId } = parsed.data;
    const outcome = await issueReceipt(ports, { principalId, projectId } as TenantScope, payoutId, {
      correlationId: helpers.correlationId,
    });
    if (outcome.status === 'blocked' && RETRY_REASONS.has(outcome.reason)) {
      throw new ReceiptUnverifiedError(`the chain has not confirmed it: ${outcome.reason}`);
    }
  };
}
