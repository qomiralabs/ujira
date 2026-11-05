// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What became of a transaction once it left. Only getTransaction proves one
// landed, and NOT_FOUND on its own proves nothing: the RPC keeps a window of
// ledgers, so a transaction outside it reads the same as one that never
// existed. A job may build a new transaction only once the old one provably
// cannot land, because building one too early is how a payout goes out twice.

import { xdr } from '@stellar/stellar-sdk/base';

import type { NetworkId } from '../networks.js';
import { reservationIdOf } from '../sponsorship/policy.js';
import { canMoveSubmission } from '../submission-states.js';
import type {
  AdapterPorts,
  CallOptions,
  NativeAmount,
  SubmissionPatch,
  SubmissionRecord,
  SubmissionState,
  TenantScope,
} from '../types.js';
import type { RpcTransaction, StellarRpc } from './rpc.js';

/** Two base reserves for a funding account and one for its trustline, at 0.5 XLM each. */
export const FUNDING_ACCOUNT_RESERVES_STROOPS = 15_000_000n;

export type SubmissionFate =
  /** Included, successfully or not. A failed one still used its sequence and paid its fee. */
  | {
      readonly kind: 'landed' | 'failed';
      readonly ledger: bigint;
      readonly feeCharged: bigint | null;
    }
  /** Not seen, and its validity window is still open, so it may yet land. */
  | { readonly kind: 'pending' }
  /** Not seen, past its window, with the RPC's retention covering all of it. It can never land. */
  | { readonly kind: 'dead' }
  /** Not seen, and nothing here can prove what happened. The mandate's record decides. */
  | { readonly kind: 'unknown' };

export function feeChargedOf(tx: Pick<RpcTransaction, 'resultXdr'>): bigint | null {
  if (tx.resultXdr === undefined) return null;
  try {
    return xdr.TransactionResult.fromXdr(tx.resultXdr, 'base64').feeCharged;
  } catch {
    // The fee stays reserved at its maximum, which only ever overstates spend.
    return null;
  }
}

/**
 * Reads a getTransaction answer against what was recorded before the send.
 * Dead takes all three: a known upper time bound that a closed ledger has
 * passed, a known ledger from before the send, and retention reaching back to
 * it. Lacking any of them, the answer is unknown and never dead.
 */
export function fateOf(
  tx: RpcTransaction,
  record: Pick<SubmissionRecord, 'maxTime' | 'submittedAtLedger'>,
): SubmissionFate {
  if (tx.status !== 'NOT_FOUND') {
    return {
      kind: tx.status === 'SUCCESS' ? 'landed' : 'failed',
      ledger: BigInt(tx.ledger ?? 0),
      feeCharged: feeChargedOf(tx),
    };
  }
  const { maxTime, submittedAtLedger } = record;
  const closed = tx.latestLedgerCloseTime;
  if (maxTime === null || closed === undefined) return { kind: 'unknown' };
  if (closed <= maxTime) return { kind: 'pending' };
  const oldest = tx.oldestLedger;
  if (submittedAtLedger === null || oldest === undefined) return { kind: 'unknown' };
  return BigInt(oldest) <= submittedAtLedger ? { kind: 'dead' } : { kind: 'unknown' };
}

export interface ReconcileContext {
  readonly network: NetworkId;
  readonly rpc: StellarRpc;
  readonly ports: AdapterPorts;
}

export interface ReconcileResult {
  readonly txHash: string;
  readonly state: SubmissionState;
  /** True only when the transaction can never land, so a new one cannot pay twice. */
  readonly mayRebuild: boolean;
}

function stroops(network: NetworkId, amount: bigint): NativeAmount {
  return { network, asset: 'XLM', amount, scale: 7 };
}

/**
 * Books what one of UJIRA's own transactions cost. The reservation id comes from the
 * hash, so a send that waited and a later sweep over the same transaction book one
 * row. With no fee to read nothing can be booked, and the record is about to close, so
 * that spend would go uncounted with nobody knowing: it is reported instead.
 */
export async function bookExecutorFee(
  ctx: ReconcileContext,
  scope: TenantScope,
  txHash: string,
  feeCharged: bigint | null,
  correlationId: string,
): Promise<void> {
  const { network, ports } = ctx;
  if (feeCharged === null) {
    ports.alerts.divergence({
      network,
      kind: 'balance',
      detail: 'executor_fee_unreadable',
      correlationId,
    });
    return;
  }
  await ports.sponsorship.book({
    scope,
    network,
    reservationId: reservationIdOf(network, Buffer.from(txHash, 'hex')),
    intent: 'executor',
    actualFee: stroops(network, feeCharged),
  });
}

/**
 * Asks the chain about one recorded submission and moves its record forward.
 * What it cost is booked when it was included: a sponsored transaction settles
 * its reservation, and one of UJIRA's own is booked as executor spend.
 */
export async function reconcileSubmission(
  ctx: ReconcileContext,
  record: SubmissionRecord,
  opts: CallOptions,
): Promise<ReconcileResult> {
  const { network, rpc, ports } = ctx;
  const fate = fateOf(await rpc.getTransaction(record.txHash, opts), record);
  const { scope, txHash, reservationId } = record;
  const forFundingAccount = record.op === 'create_funding_account';
  let state = record.state;

  const move = async (to: SubmissionState, patch: SubmissionPatch = {}): Promise<void> => {
    // Built means it may or may not have left. Every outcome goes through
    // broadcast, the only way out of built.
    if (state === 'built') {
      await ports.store.updateSubmission(scope, network, txHash, { state: 'broadcast' });
      state = 'broadcast';
    }
    if (!canMoveSubmission(state, to)) return;
    await ports.store.updateSubmission(scope, network, txHash, { ...patch, state: to });
    state = to;
  };

  switch (fate.kind) {
    case 'landed':
    case 'failed':
      // The cost goes first. Both calls change nothing the second time, so a
      // crash between here and the move is put right by the next sweep, where
      // the other order would leave a closed record whose fee is never counted.
      if (forFundingAccount && fate.kind === 'failed' && reservationId !== null) {
        // No account exists, so the principal may try again. Settling here would
        // hold its one sponsored account for good, whichever of this and the
        // flow's own confirmation got there first.
        await ports.sponsorship.release({ scope, reservationId });
      } else {
        // Reserves are locked rather than burned, but the budget is for what the
        // sponsor gives up, and they are given up only by one that landed.
        const reserves =
          forFundingAccount && fate.kind === 'landed' ? FUNDING_ACCOUNT_RESERVES_STROOPS : 0n;
        const cost = fate.feeCharged === null ? null : fate.feeCharged + reserves;
        if (reservationId === null) {
          await bookExecutorFee(ctx, scope, txHash, cost, record.correlationId);
        } else if (cost !== null) {
          await ports.sponsorship.settle({
            scope,
            reservationId,
            actualFee: stroops(network, cost),
          });
        }
      }
      await move(fate.kind, {
        landedAtHeight: fate.ledger,
        ...(fate.kind === 'failed' ? { errorCode: 'SUBMISSION_REJECTED' as const } : {}),
      });
      return { txHash, state, mayRebuild: false };
    case 'dead':
      if (reservationId !== null) await ports.sponsorship.release({ scope, reservationId });
      await move('expired');
      return { txHash, state, mayRebuild: true };
    case 'unknown':
      await move('unknown');
      return { txHash, state, mayRebuild: false };
    case 'pending':
      return { txHash, state, mayRebuild: false };
  }
}

export interface SweepOptions {
  /** Submissions at least this old. */
  readonly olderThanSeconds: number;
  readonly limit: number;
  /** One still unresolved past this age raises the stuck alert. */
  readonly stuckAfterSeconds: number;
}

/**
 * Reconciles what is still open, oldest first, so a crash after a send is
 * always found again. One submission failing to read never stops the rest.
 */
export async function reconcileUnresolved(
  ctx: ReconcileContext,
  sweep: SweepOptions,
  opts: CallOptions,
): Promise<readonly ReconcileResult[]> {
  const { network, ports } = ctx;
  const open = await ports.store.unresolvedSubmissions(
    network,
    sweep.olderThanSeconds,
    sweep.limit,
  );
  const results: ReconcileResult[] = [];
  for (const record of open) {
    try {
      const result = await reconcileSubmission(ctx, record, opts);
      results.push(result);
      const age = Number(ports.clock.nowSeconds() - record.createdAt);
      if (
        age >= sweep.stuckAfterSeconds &&
        (result.state === 'broadcast' || result.state === 'unknown')
      ) {
        ports.alerts.stuck({
          network,
          txHash: record.txHash,
          ageSeconds: age,
          correlationId: record.correlationId,
        });
      }
    } catch {
      results.push({ txHash: record.txHash, state: record.state, mayRebuild: false });
    }
  }
  return results;
}
