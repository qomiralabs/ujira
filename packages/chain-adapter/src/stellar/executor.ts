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
  ExecutorUnfundedError,
  SubmissionRejectedError,
  SubmissionUnknownError,
  isChainAdapterError,
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
import { resourceFailureOf } from './soroban-rules.js';
import { submitEnvelope } from './submit.js';
import { accountState, attach, txHash, waitForTransaction } from './tx.js';
import type { WaitOptions } from './tx.js';

export interface ExecutorContext {
  readonly network: StellarNetworkId;
  readonly rpc: StellarRpc;
  readonly ports: AdapterPorts;
  readonly wait: WaitOptions;
  readonly leaseSeconds: number;
  /** How long a send may take before its outcome counts as unknown. */
  readonly submitTimeoutMs: number;
  /** Channels already reported low, so a drop alerts once and not on every job. */
  readonly lowBalanceAlerted: Set<string>;
}

function checkChannelBalance(ctx: ExecutorContext, address: string, balance: bigint): void {
  const { network, ports, lowBalanceAlerted } = ctx;
  const limits = ports.config()[network]?.executor;
  if (limits === undefined) return;
  if (balance >= limits.lowBalanceStroops) {
    lowBalanceAlerted.delete(address);
  } else if (!lowBalanceAlerted.has(address)) {
    lowBalanceAlerted.add(address);
    ports.alerts.lowBalance({
      network,
      account: 'executor',
      balance: { network, asset: 'XLM', amount: balance, scale: 7 },
      threshold: { network, asset: 'XLM', amount: limits.lowBalanceStroops, scale: 7 },
    });
  }
  if (balance < limits.minBalanceStroops) throw new ExecutorUnfundedError({ network });
}

export interface SendRecord {
  readonly scope: TenantScope;
  readonly op: SubmissionOp;
  readonly mandate: string | null;
  readonly correlationId: string;
}

// A send the network refused for resources. Only sendFresh sees it: it either
// retries or turns it into a rejection, so it never reaches a caller, and
// nothing can read it as a mandate decision.
class ResourceFailureSignal extends Error {
  override readonly name = 'ResourceFailureSignal';
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
      const account = await accountState(ctx.rpc, lease.address.value, opts);
      if (account === null) throw new ExecutorUnfundedError({ network: ctx.network });
      checkChannelBalance(ctx, lease.address.value, account.balance);
      session = new ExecutorSession(ctx, lease, account.sequence);
      return await work(session);
    } finally {
      // The next holder reads the chain anyway; this is the best guess of
      // what it will find.
      const next = session === null ? lease.sequenceOrNonce : session.sequence + 1n;
      // A refusal here means the lease was taken over or the store is down.
      // Either way the fencing did its job and the lease lapses on its own, and
      // neither changes what this job did, so it never replaces the job's
      // own outcome.
      await ctx.ports.store
        .releaseExecutor(lease, { sequenceOrNonce: next })
        .catch(() => undefined);
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
      submittedAtLedger: BigInt((await rpc.getLatestLedger(opts)).sequence),
      reservationId: null,
      correlationId: record.correlationId,
      createdAt: ports.clock.nowSeconds(),
    });
    // From here the sequence may be used, whatever the answer.
    this.sequence = BigInt(tx.sequence);
    await sendAndRecord(this.ctx, record.scope, hash, tx.toXdr(), maxTime, opts);
    if (!wait) return { hash, landed: null };
    const landed = await waitForTransaction(rpc, network, hash, this.ctx.wait, opts);
    if (landed.status !== 'SUCCESS') {
      await ports.store.updateSubmission(record.scope, network, hash, {
        state: 'failed',
        errorCode: 'SUBMISSION_REJECTED',
      });
      if (resourceFailureOf(landed.resultXdr) !== null) throw new ResourceFailureSignal();
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
 * Sends a transaction built by `build`, which simulates afresh on every call,
 * so no footprint is reused. A resource failure is re-simulated and resubmitted
 * at most the configured number of times, then fails as SUBMISSION_REJECTED
 * with nothing landed, never as a mandate rule.
 */
export async function sendFresh(
  ctx: Pick<ExecutorContext, 'network' | 'ports'>,
  session: ExecutorSession,
  build: () => Promise<Transaction>,
  record: SendRecord,
  opts: CallOptions,
): Promise<{ readonly hash: string; readonly landed: RpcTransaction | null }> {
  const retries = ctx.ports.config()[ctx.network]?.soroban.resimulateRetries ?? 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await session.send(await build(), record, opts, true);
    } catch (error) {
      if (!(error instanceof ResourceFailureSignal)) throw error;
    }
  }
  throw new SubmissionRejectedError({ network: ctx.network, landed: 'no' });
}

/**
 * Sends a recorded envelope and moves its record on. It is marked broadcast
 * before the send, the only way out of built, so a crash during the send
 * leaves a record that says it may have left. TRY_AGAIN_LATER means the node
 * is busy, not that it refused, so the identical envelope goes again until its
 * attempts or its maxTime run out, and it stays broadcast for reconciliation,
 * since an earlier try may have been taken. A definite refusal is final.
 */
export async function sendAndRecord(
  ctx: Pick<ExecutorContext, 'network' | 'rpc' | 'ports' | 'submitTimeoutMs' | 'wait'>,
  scope: TenantScope,
  hash: string,
  envelopeXdr: string,
  maxTime: bigint | null,
  opts: CallOptions,
): Promise<void> {
  const { network, rpc, ports, wait } = ctx;
  await ports.store.updateSubmission(scope, network, hash, { state: 'broadcast' });
  for (let attempt = 1; ; attempt += 1) {
    let result;
    try {
      result = await submitEnvelope(
        {
          send: (envelope, signal) =>
            rpc.sendTransaction(envelope, {
              ...opts,
              signal: opts.signal === undefined ? signal : AbortSignal.any([signal, opts.signal]),
            }),
        },
        envelopeXdr,
        { network, timeoutMs: ctx.submitTimeoutMs },
      );
    } catch (error) {
      // Refused with nothing sent is final for this envelope. Anything else
      // may have reached the network, so it stays open for reconciliation.
      const refused = isChainAdapterError(error) && error.landed === 'no';
      await ports.store.updateSubmission(
        scope,
        network,
        hash,
        refused ? { state: 'failed', errorCode: error.code } : { state: 'unknown' },
      );
      throw error;
    }
    if (result.status === 'PENDING' || result.status === 'DUPLICATE') return;
    if (result.status === 'ERROR') {
      await ports.store.updateSubmission(scope, network, hash, {
        state: 'failed',
        errorCode: 'SUBMISSION_REJECTED',
      });
      throw new SubmissionRejectedError({ network });
    }
    const now = ports.clock.nowSeconds();
    if (attempt >= wait.attempts || (maxTime !== null && now >= maxTime)) {
      throw new SubmissionUnknownError({ network });
    }
    await wait.sleep(wait.intervalMs);
  }
}
