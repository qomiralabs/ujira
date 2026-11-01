// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One job's use of a leased channel account. The lease is the only thing that
// lets a job use the account, and its lease id is the fencing token: the
// store refuses a release with any other id, so a job that outlived its lease
// cannot write a sequence back over the job that took the account over. The
// sequence itself is always read from the chain, never trusted from the
// lease, because the job that held the account before may have sent more
// than it reported.

import type { Transaction } from '@stellar/stellar-sdk/base';

import {
  ChainUnavailableError,
  ExecutorUnfundedError,
  SubmissionRejectedError,
} from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type {
  AdapterPorts,
  CallOptions,
  ExecutorLease,
  SubmissionOp,
  TenantScope,
  UnixSeconds,
} from '../types.js';
import type { RpcTransaction, StellarRpc } from './rpc.js';
import { accountSequence, attach, txHash, waitForTransaction } from './tx.js';
import type { WaitOptions } from './tx.js';

export interface ExecutorContext {
  readonly network: StellarNetworkId;
  readonly rpc: StellarRpc;
  readonly ports: AdapterPorts;
  readonly wait: WaitOptions;
  readonly leaseSeconds: number;
}

export interface SendRecord {
  readonly scope: TenantScope;
  readonly op: SubmissionOp;
  readonly mandate: string | null;
  readonly correlationId: string;
}

export class ExecutorSession {
  /** The account's sequence as last used, so the next transaction takes one more. */
  sequence: bigint;
  private constructor(
    private readonly ctx: ExecutorContext,
    readonly lease: ExecutorLease,
    sequence: bigint,
  ) {
    this.sequence = sequence;
  }

  get address(): string {
    return this.lease.address.value;
  }

  /** Leases an account, runs `work` with it and always releases the lease. */
  static async run<T>(
    ctx: ExecutorContext,
    opts: CallOptions,
    work: (session: ExecutorSession) => Promise<T>,
  ): Promise<T> {
    const lease = await ctx.ports.store.leaseExecutor(ctx.network, ctx.leaseSeconds);
    let session: ExecutorSession | null = null;
    try {
      const sequence = await accountSequence(ctx.rpc, lease.address.value, opts);
      if (sequence === null) throw new ExecutorUnfundedError({ network: ctx.network });
      session = new ExecutorSession(ctx, lease, sequence);
      return await work(session);
    } finally {
      // The next holder reads the chain anyway; this is the best guess of
      // what it will find.
      const next = session === null ? lease.sequenceOrNonce : session.sequence + 1n;
      await ctx.ports.store.releaseExecutor(lease, { sequenceOrNonce: next });
    }
  }

  /**
   * Signs `tx` with the leased key, records it, sends it and, with `wait`,
   * waits for it to land. Returns the hash. The transaction must use the
   * next sequence of this account.
   */
  async send(
    tx: Transaction,
    record: SendRecord,
    opts: CallOptions,
    wait: boolean,
  ): Promise<{ readonly hash: string; readonly landed: RpcTransaction | null }> {
    const { network, ports, rpc } = this.ctx;
    const signature = await ports.signer.sign(
      { kind: 'executor', network, keyId: this.lease.keyId },
      { kind: 'stellar_tx', network, xdr: tx.toXdr() },
      opts,
    );
    attach(tx, this.address, signature);
    const hash = txHash(tx);
    const maxTime =
      tx.timeBounds === undefined ? null : (BigInt(tx.timeBounds.maxTime) as UnixSeconds);
    await ports.store.recordSubmission({
      scope: record.scope,
      network,
      txHash: hash,
      op: record.op,
      mandate: record.mandate,
      payoutId: null,
      attempt: null,
      signerAddress: this.address,
      sequenceOrNonce: BigInt(tx.sequence),
      maxTime,
      state: 'built',
      landedAtHeight: null,
      errorCode: null,
      specCode: null,
      replacesTxHash: null,
      correlationId: record.correlationId,
      createdAt: ports.clock.nowSeconds(),
    });
    // From here the sequence may be used, whatever the answer.
    this.sequence = BigInt(tx.sequence);
    await sendAndRecord(this.ctx, record.scope, hash, tx.toXdr(), opts);
    if (!wait) return { hash, landed: null };
    const landed = await waitForTransaction(rpc, network, hash, this.ctx.wait, opts);
    if (landed.status !== 'SUCCESS') {
      await ports.store.updateSubmission(record.scope, network, hash, {
        state: 'failed',
        errorCode: 'SUBMISSION_REJECTED',
      });
      throw new SubmissionRejectedError({ network, landed: 'yes' });
    }
    await ports.store.updateSubmission(record.scope, network, hash, {
      state: 'landed',
      landedAtHeight: BigInt(landed.ledger ?? 0),
    });
    return { hash, landed };
  }
}

/**
 * Sends a recorded envelope and moves its record on. Only an answer that the
 * node holds the transaction counts as broadcast; a refusal is final for this
 * envelope, and anything unanswered is left unknown for reconciliation.
 */
export async function sendAndRecord(
  ctx: Pick<ExecutorContext, 'network' | 'rpc' | 'ports'>,
  scope: TenantScope,
  hash: string,
  envelopeXdr: string,
  opts: CallOptions,
): Promise<void> {
  const { network, rpc, ports } = ctx;
  let result;
  try {
    result = await rpc.sendTransaction(envelopeXdr, opts);
  } catch (error) {
    await ports.store.updateSubmission(scope, network, hash, { state: 'unknown' });
    throw error;
  }
  if (result.status === 'PENDING' || result.status === 'DUPLICATE') {
    await ports.store.updateSubmission(scope, network, hash, { state: 'broadcast' });
    return;
  }
  const busy = result.status === 'TRY_AGAIN_LATER';
  await ports.store.updateSubmission(scope, network, hash, {
    state: 'failed',
    errorCode: busy ? 'CHAIN_UNAVAILABLE' : 'SUBMISSION_REJECTED',
  });
  throw busy ? new ChainUnavailableError({ network }) : new SubmissionRejectedError({ network });
}
