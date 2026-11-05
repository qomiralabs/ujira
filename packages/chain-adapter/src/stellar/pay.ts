// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How a payout moves on the wallet rail. Each call reads where the payout stands
// on the chain and does at most one missing step, so a crash or a retry between
// any two steps finds the same answer and can never pay twice: the mandate's
// record for a payout ID is the only state that counts, and everything held here
// only points at it.

import type { Transaction, xdr } from '@stellar/stellar-sdk/base';

import { planBatch } from '../bisect.js';
import type { BatchSimulation, BatchSimulationPort } from '../bisect.js';
import {
  ChainUnavailableError,
  DestinationInvalidError,
  InternalError,
  InvalidInputError,
  MandateRuleError,
  SubmissionRejectedError,
  UnsupportedError,
  isChainAdapterError,
} from '../errors.js';
import type { ChainAdapterError } from '../errors.js';
import { feeCap } from '../fee-cap.js';
import { MANDATE_ERRORS, mandateErrorName } from '../mandate-errors.js';
import type { MandateErrorName } from '../mandate-errors.js';
import type { StellarNetworkConfig } from '../config.js';
import type { SignerRef } from '../signer.js';
import type { StellarNetworkId } from '../networks.js';
import { formatReceiptRef, parseReceiptRef } from '../receipt-ref.js';
import { isLiveSubmission } from '../submission-states.js';
import { tokenAmount } from '@ujira/core';
import type {
  AdapterPorts,
  BatchStep,
  Bytes32,
  CallOptions,
  ChainReceipt,
  DeadProof,
  Destination,
  LegDeliveryStatus,
  MandateRef,
  PayBatchRequest,
  PayRequest,
  PayStep,
  PayoutChainStatus,
  PayoutId,
  CancelLapsedRequest,
  CancelLapsedStep,
  ProveDeadRequest,
  ReceiptLeg,
  ReceiptRef,
  ReceiptRequest,
  ReceiptVerification,
  SignedSubmission,
  SigningRequest,
  StatusRequest,
  SubmissionOp,
  SubmissionRef,
  TenantScope,
  UnixSeconds,
} from '../types.js';
import type { EventJson } from '../intake.js';
import { readDestination } from './destination-check.js';
import type { DestinationState } from './destination-check.js';
import { isEventsLimitFailure } from './events-limit.js';
import { ledgerEventOf } from './events.js';
import { ExecutorSession } from './executor.js';
import type { ExecutorContext } from './executor.js';
import { feeChargedOf, reconcileSubmission } from './lifecycle.js';
import type { Invocation } from './calls.js';
import { parseStellarDestination } from './parse-destination.js';
import { batchResultsOf, payoutRequestScVal, payoutViewOf } from './payout-views.js';
import type { PayoutView } from './payout-views.js';
import { callFailure } from './sim-errors.js';
import type { StellarRpc } from './rpc.js';
import { address, bytes32, sym, vec } from './scval.js';
import type { MandateInstance } from './trust.js';
import {
  attach,
  invokeTx,
  parseEnvelope,
  readTx,
  returned,
  simulate,
  simulatedData,
} from './tx.js';
import { configViewOf, stateOf } from './views.js';

/** Where a leg's destination is kept. The adapter never takes one from a caller. */
export interface PayoutMethodSource {
  destination(scope: TenantScope, methodId: string, opts: CallOptions): Promise<Destination | null>;
}

/** The indexer's copy of a payout_executed, for a receipt past the RPC's retention. */
export interface MirroredExecution {
  readonly txHash: string;
  readonly eventIndex: number;
  readonly ledger: bigint;
  readonly closedAt: string;
  readonly fields: Readonly<Record<string, EventJson>>;
  /** Null when the fee was not read before it left the window. */
  readonly feeCharged: bigint | null;
}

export interface ExecutionMirror {
  executed(
    scope: TenantScope,
    mandate: string,
    payoutId: PayoutId,
    opts: CallOptions,
  ): Promise<MirroredExecution | null>;
}

export interface PayContext {
  readonly network: StellarNetworkId;
  readonly rpc: StellarRpc;
  readonly ports: AdapterPorts;
  readonly executor: ExecutorContext;
  readonly methods: PayoutMethodSource;
  readonly mirror: ExecutionMirror | null;
  readonly maxBisectRounds: number;
  readonly config: () => StellarNetworkConfig;
  readonly verify: (
    scope: TenantScope,
    mandate: MandateRef,
    opts: CallOptions,
  ) => Promise<MandateInstance>;
  /** Builds what an agent's own wallet signs, as for any other mandate call. */
  readonly prepare: (
    call: {
      readonly scope: TenantScope;
      readonly mandate: MandateRef;
      readonly op: 'request' | 'request_batch';
      readonly inv: Invocation;
      readonly signer: string;
      readonly target: string;
      readonly payoutId: PayoutId | null;
      readonly attempt?: number | null;
    },
    opts: CallOptions,
  ) => Promise<SigningRequest>;
  /** Sends what was signed, in the sponsor's fee bump. */
  readonly submit: (req: SignedSubmission, opts: CallOptions) => Promise<SubmissionRef>;
}

const WALLET_RAIL = 'stellar.wallet';
const MAX_LEGS = 10;
const MAX_BATCH = 10;
/** How far back a receipt looks when no stored submission says where: about a day. */
const RECEIPT_SCAN_LEDGERS = 17_280;

function rule(network: StellarNetworkId, name: MandateErrorName): MandateRuleError {
  return new MandateRuleError(MANDATE_ERRORS[name], name, { network });
}

function invalid(network: StellarNetworkId, issue: string): InvalidInputError {
  return new InvalidInputError({ network, issues: [issue] });
}

function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId;
}

/** A payment request's own shape, before anything is read or signed for it. */
function checkPay(network: StellarNetworkId, req: PayRequest): void {
  if (req.total.amount < 1n) throw invalid(network, 'total (not_positive)');
  if (req.fee.amount < 0n) throw invalid(network, 'fee (negative)');
  if (!Number.isSafeInteger(req.attempt) || req.attempt < 1) {
    throw invalid(network, 'attempt (invalid)');
  }
  if (req.legs.length < 1 || req.legs.length > MAX_LEGS) {
    throw invalid(network, 'legs (invalid_length)');
  }
  let sum = 0n;
  const indexes = new Set<number>();
  for (const leg of req.legs) {
    sum += leg.amount.amount;
    indexes.add(leg.index);
    const id: string = req.payoutId;
    if (!leg.legKey.startsWith(id) || leg.legKey.length !== id.length + 2) {
      throw invalid(network, 'legs.legKey (mismatch)');
    }
  }
  if (indexes.size !== req.legs.length || [...indexes].some((i) => i < 0 || i >= MAX_LEGS)) {
    throw invalid(network, 'legs.index (invalid)');
  }
  if (sum !== req.total.amount) throw invalid(network, 'legs (sum_mismatch)');
}

export class StellarPayouts {
  readonly #c: PayContext;

  constructor(context: PayContext) {
    this.#c = context;
  }

  // -------------------------------------------------------------------------
  // Steps

  async pay(req: PayRequest, opts: CallOptions): Promise<PayStep> {
    const { network, ports, executor } = this.#c;
    const instance = await this.#c.verify(req.scope, req.mandate, opts);
    checkPay(network, req);
    // Anything sent and not yet accounted for comes first. Building another
    // transaction while one may still land is how a payout goes out twice.
    for (const op of ['request', 'execute'] as const) {
      const live = await ports.store.liveSubmission({
        scope: req.scope,
        network,
        mandate: instance.address,
        payoutId: req.payoutId,
        op,
      });
      if (live === null) continue;
      const { state } = await reconcileSubmission(executor, live, opts);
      if (isLiveSubmission(state)) {
        return {
          kind: 'submitted',
          op,
          submission: { network, txHash: live.txHash, finality: 'none' },
        };
      }
    }
    const view = await this.#view(instance.address, req.payoutId, opts);
    switch (view.kind) {
      case 'absent': {
        const dead = await this.#deadlineProof(req.deadline, opts);
        return dead === null
          ? this.#requestStep(instance, req, opts)
          : { kind: 'dead', proof: dead };
      }
      case 'closed':
        return this.#closedStep(req, view.status, opts);
      case 'open': {
        if (view.total !== req.total.amount) throw invalid(network, 'payoutId (mismatch)');
        const { config } = await this.#mandateConfig(instance, opts);
        if (view.status === 'pending') {
          return {
            kind: 'awaiting_approval',
            approvals: { count: view.approvals, required: config.approvalsRequired },
          };
        }
        if ((await this.#now(opts)) >= view.expiresAt) throw rule(network, 'PAYOUT_LAPSED');
        if (req.execute === 'hold') return { kind: 'held' };
        // A cap lowered after the request would fail the execution on chain.
        if (view.fee > feeCap(view.total, config.maxFeeBps)) {
          throw rule(network, 'FEE_EXCEEDS_CAP');
        }
        return this.#executeStep(instance, req, opts);
      }
    }
  }

  async #closedStep(
    req: PayRequest,
    status: 'executed' | 'rejected' | 'cancelled',
    opts: CallOptions,
  ): Promise<PayStep> {
    if (status === 'executed') {
      return { kind: 'final', receipt: await this.receipt(req, opts) };
    }
    return { kind: 'dead', proof: await this.#tombstone(status, opts) };
  }

  async #requestStep(
    instance: MandateInstance,
    req: PayRequest,
    opts: CallOptions,
  ): Promise<PayStep> {
    const { network } = this.#c;
    const { config, policyEpoch } = await this.#mandateConfig(instance, opts);
    // Checked here first, so a payout the mandate would refuse never costs a
    // signature or a network fee. The contract's own expression, unrounded.
    if (req.fee.amount > feeCap(req.total.amount, config.maxFeeBps)) {
      throw rule(network, 'FEE_EXCEEDS_CAP');
    }
    const destinations = await this.#destinations(req, opts);
    await this.#recordDeliveries(req, destinations);
    const signer = await this.#signerAddress(req.signer, opts);
    const inv: Invocation = {
      contract: instance.address,
      fn: 'request_payout',
      args: [address('caller', signer), payoutRequestScVal(req, destinations, BigInt(policyEpoch))],
    };
    if (req.signer.kind === 'external') {
      const request = await this.#c.prepare(
        {
          scope: req.scope,
          mandate: req.mandate,
          op: 'request',
          inv,
          signer,
          target: instance.address,
          payoutId: req.payoutId,
        },
        opts,
      );
      return { kind: 'signature_required', request };
    }
    const submission = await this.#sendAsAgent(
      req.scope,
      req.mandate,
      req.signer,
      inv,
      signer,
      {
        op: 'request',
        payoutId: req.payoutId,
        attempt: req.attempt,
      },
      opts,
    );
    return { kind: 'submitted', op: 'request', submission };
  }

  /** A leg's destination must exist, be on this rail and be able to take its amount now. */
  async #destinations(
    req: PayRequest,
    opts: CallOptions,
  ): Promise<ReadonlyMap<string, Destination>> {
    const { network } = this.#c;
    const issuer = this.#c.config().assets.USDC.issuer;
    const found = new Map<string, Destination>();
    for (const leg of req.legs) {
      if (leg.rail !== WALLET_RAIL) throw new UnsupportedError({ network });
      const to = await this.#c.methods.destination(req.scope, leg.recipientMethodId, opts);
      if (to === null) throw invalid(network, 'legs.recipientMethodId (unknown)');
      const state = await readDestination(
        this.#c.rpc,
        issuer,
        { destination: to, amount: leg.amount.amount },
        opts,
      );
      if (!state.receivable) throw new DestinationInvalidError({ network });
      found.set(leg.recipientMethodId, to);
    }
    return found;
  }

  async #recordDeliveries(
    req: PayRequest,
    destinations: ReadonlyMap<string, Destination>,
  ): Promise<void> {
    const { network, ports } = this.#c;
    for (const leg of req.legs) {
      if ((await ports.store.liveDelivery(req.scope, leg.legKey)) !== null) continue;
      const destination = destinations.get(leg.recipientMethodId);
      if (destination === undefined) throw new InternalError({ network });
      await ports.store.upsertDelivery({
        scope: req.scope,
        legKey: leg.legKey,
        network,
        rail: leg.rail,
        provider: 'wallet',
        providerRef: null,
        destination,
        quoteId: leg.quoteId ?? null,
        state: 'not_applicable',
        rawStatus: null,
        live: true,
        expiresAt: null,
        updatedAt: ports.clock.nowSeconds(),
      });
    }
  }

  /**
   * The agent key signs its own transaction and the sponsor pays for it in a fee
   * bump, the same path a principal's takes. A channel account cannot send this:
   * an executor key is only ever allowed to sign execute calls, so a compromised
   * executor can never ask for a payout.
   */
  async #sendAsAgent(
    scope: TenantScope,
    mandate: MandateRef,
    signerRef: SignerRef,
    inv: Invocation,
    agent: string,
    record: {
      readonly op: 'request' | 'request_batch';
      readonly payoutId: PayoutId | null;
      readonly attempt: number | null;
    },
    opts: CallOptions,
  ): Promise<SubmissionRef> {
    const { network, ports } = this.#c;
    const request = await this.#c.prepare(
      { scope, mandate, inv, signer: agent, target: inv.contract, ...record },
      opts,
    );
    if (request.kind !== 'stellar_transaction') throw new SubmissionRejectedError({ network });
    const tx = parseEnvelope(request.xdr, network) as Transaction;
    const signature = await ports.signer.sign(
      signerRef,
      { kind: 'stellar_tx', network, xdr: request.xdr },
      opts,
    );
    attach(tx, agent, signature);
    return this.#c.submit(
      {
        scope,
        requestId: request.requestId,
        signed: tx.toXdr(),
        correlationId: opts.correlationId,
      },
      opts,
    );
  }

  async #executeStep(
    instance: MandateInstance,
    req: PayRequest,
    opts: CallOptions,
  ): Promise<PayStep> {
    const { network, rpc, ports, executor } = this.#c;
    const config = this.#c.config();
    const submission = await ExecutorSession.run(executor, opts, async (session) => {
      const inv: Invocation = {
        contract: instance.address,
        fn: 'execute',
        args: [address('caller', session.address), bytes32('payoutId', req.payoutId)],
      };
      const build = {
        network,
        source: session.address,
        sequence: session.sequence,
        maxTime: ports.clock.nowSeconds() + BigInt(config.executor.txValiditySeconds),
      };
      const sim = await simulate(rpc, network, invokeTx(inv, build), inv.contract, opts).catch(
        (error: unknown) => {
          this.#alertRemoved(error, req.scope, req.payoutId, opts);
          throw error;
        },
      );
      return this.#assembleAndSend(
        session,
        req.scope,
        inv,
        build,
        sim.result?.auth ?? [],
        { op: 'execute', payoutId: req.payoutId, attempt: req.attempt },
        opts,
      );
    });
    return { kind: 'submitted', op: 'execute', submission };
  }

  /** A removed agent's payout can never execute, and the principal needs to know it was queued. */
  #alertRemoved(error: unknown, scope: TenantScope, payoutId: PayoutId, opts: CallOptions): void {
    if (error instanceof MandateRuleError && error.specName === 'AGENT_REMOVED') {
      this.#c.ports.alerts.batch({
        network: this.#c.network,
        kind: 'agent_removed',
        scope,
        payoutId,
        correlationId: opts.correlationId,
      });
    }
  }

  async #assembleAndSend(
    session: ExecutorSession,
    scope: TenantScope,
    inv: Invocation,
    build: Parameters<typeof invokeTx>[1],
    auth: readonly xdr.SorobanAuthorizationEntry[],
    record: {
      readonly op: SubmissionOp;
      readonly payoutId: PayoutId | null;
      readonly attempt: number | null;
    },
    opts: CallOptions,
  ): Promise<SubmissionRef> {
    const { network, rpc } = this.#c;
    // Simulated again with the signatures in place, so the footprint covers
    // what the signature checks read.
    const sim = await simulate(rpc, network, invokeTx(inv, build, auth), inv.contract, opts);
    const assembled = invokeTx(inv, { ...build, sorobanData: simulatedData(sim) }, auth);
    const { hash } = await session.send(
      assembled,
      { scope, mandate: inv.contract, correlationId: opts.correlationId, ...record },
      opts,
      false,
    );
    return { network, txHash: hash, finality: 'none' };
  }

  // -------------------------------------------------------------------------
  // Batches

  async payBatch(req: PayBatchRequest, opts: CallOptions): Promise<BatchStep> {
    const { network } = this.#c;
    const instance = await this.#c.verify(req.scope, req.mandate, opts);
    if (req.items.length < 1 || req.items.length > MAX_BATCH) {
      throw invalid(network, 'items (invalid_length)');
    }
    for (const item of req.items) {
      if (!sameScope(item.scope, req.scope) || item.mandate.address.value !== instance.address) {
        throw invalid(network, 'items.mandate (mismatch)');
      }
      checkPay(network, item);
    }
    if (new Set(req.items.map((i) => i.payoutId)).size !== req.items.length) {
      throw invalid(network, 'items.payoutId (duplicate)');
    }
    const views = new Map<PayoutId, PayoutView>();
    for (const item of req.items) {
      views.set(item.payoutId, await this.#view(instance.address, item.payoutId, opts));
    }
    const steps = new Map<PayoutId, BatchStep['items'][number]['step']>();
    const submissions: SubmissionRef[] = [];
    await this.#requestBatch(instance, req, views, steps, submissions, opts);
    await this.#executeBatch(instance, req, views, steps, submissions, opts);
    const items: BatchStep['items'][number][] = [];
    for (const item of req.items) {
      const step =
        steps.get(item.payoutId) ?? (await this.#settledStep(instance, item, views, opts));
      items.push({ payoutId: item.payoutId, step });
    }
    return { items, submissions };
  }

  /**
   * Where an item stands when this call sent nothing for it. It only reads, and a
   * failure stays with its own item: by now others may have been sent, and
   * throwing would lose the record of them.
   */
  async #settledStep(
    instance: MandateInstance,
    item: PayRequest,
    views: ReadonlyMap<PayoutId, PayoutView>,
    opts: CallOptions,
  ): Promise<BatchStep['items'][number]['step']> {
    const { network } = this.#c;
    const view = views.get(item.payoutId);
    try {
      if (view === undefined) throw new InternalError({ network });
      if (view.kind === 'closed') return await this.#closedStep(item, view.status, opts);
      if (view.kind === 'open') {
        if (view.status === 'approved') return { kind: 'held' };
        const { config } = await this.#mandateConfig(instance, opts);
        return {
          kind: 'awaiting_approval',
          approvals: { count: view.approvals, required: config.approvalsRequired },
        };
      }
      const dead = await this.#deadlineProof(item.deadline, opts);
      if (dead === null) throw invalid(network, 'payoutId (not_requested)');
      return { kind: 'dead', proof: dead };
    } catch (error) {
      if (!isChainAdapterError(error)) throw error;
      return { kind: 'item_failed', error: error.toJSON() };
    }
  }

  async #requestBatch(
    instance: MandateInstance,
    req: PayBatchRequest,
    views: ReadonlyMap<PayoutId, PayoutView>,
    steps: Map<PayoutId, BatchStep['items'][number]['step']>,
    submissions: SubmissionRef[],
    opts: CallOptions,
  ): Promise<void> {
    const { network, rpc } = this.#c;
    const now = await this.#now(opts);
    const absent = req.items.filter(
      (item) => views.get(item.payoutId)?.kind === 'absent' && now < item.deadline,
    );
    const first = absent[0];
    if (first === undefined) return;
    if (absent.some((item) => JSON.stringify(item.signer) !== JSON.stringify(first.signer))) {
      throw invalid(network, 'items.signer (mixed)');
    }
    const { config, policyEpoch } = await this.#mandateConfig(instance, opts);
    const ready: { readonly item: PayRequest; readonly to: ReadonlyMap<string, Destination> }[] =
      [];
    for (const item of absent) {
      if (item.fee.amount > feeCap(item.total.amount, config.maxFeeBps)) {
        steps.set(item.payoutId, {
          kind: 'item_failed',
          error: rule(network, 'FEE_EXCEEDS_CAP').toJSON(),
        });
        continue;
      }
      try {
        ready.push({ item, to: await this.#destinations(item, opts) });
      } catch (error) {
        if (!isChainAdapterError(error) || error.retryable) throw error;
        steps.set(item.payoutId, { kind: 'item_failed', error: error.toJSON() });
      }
    }
    if (ready.length === 0) return;
    const signer = await this.#signerAddress(first.signer, opts);
    const inv: Invocation = {
      contract: instance.address,
      fn: 'request_payouts',
      args: [
        address('caller', signer),
        vec(ready.map(({ item, to }) => payoutRequestScVal(item, to, BigInt(policyEpoch)))),
      ],
    };
    const results = batchResultsOf(
      returned(await simulate(rpc, network, readTx(network, inv), inv.contract, opts)),
    );
    const accepted = ready.filter(({ item }, i) => {
      const code = results[i]?.code ?? 0;
      if (code === 0) return true;
      const name = mandateErrorName(code);
      const error = name === undefined ? new InternalError({ network }) : rule(network, name);
      steps.set(item.payoutId, { kind: 'item_failed', error: error.toJSON() });
      return false;
    });
    if (accepted.length === 0) return;
    for (const { item, to } of accepted) await this.#recordDeliveries(item, to);
    const sending: Invocation = {
      ...inv,
      args: [
        address('caller', signer),
        vec(accepted.map(({ item, to }) => payoutRequestScVal(item, to, BigInt(policyEpoch)))),
      ],
    };
    if (first.signer.kind === 'external') {
      const request = await this.#c.prepare(
        {
          scope: req.scope,
          mandate: req.mandate,
          op: 'request_batch',
          inv: sending,
          signer,
          target: instance.address,
          payoutId: null,
        },
        opts,
      );
      for (const { item } of accepted) {
        steps.set(item.payoutId, { kind: 'signature_required', request });
      }
      return;
    }
    const submission = await this.#sendAsAgent(
      req.scope,
      req.mandate,
      first.signer,
      sending,
      signer,
      { op: 'request_batch', payoutId: null, attempt: null },
      opts,
    );
    submissions.push(submission);
    for (const { item } of accepted) {
      steps.set(item.payoutId, { kind: 'submitted', op: 'request', submission });
    }
  }

  async #executeBatch(
    instance: MandateInstance,
    req: PayBatchRequest,
    views: ReadonlyMap<PayoutId, PayoutView>,
    steps: Map<PayoutId, BatchStep['items'][number]['step']>,
    submissions: SubmissionRef[],
    opts: CallOptions,
  ): Promise<void> {
    const { network, rpc, ports, executor } = this.#c;
    const now = await this.#now(opts);
    const due = req.items.filter((item) => {
      if (steps.has(item.payoutId) || item.execute === 'hold') return false;
      const view = views.get(item.payoutId);
      return view?.kind === 'open' && view.status === 'approved' && now < view.expiresAt;
    });
    if (due.length === 0) return;
    const config = this.#c.config();
    await ExecutorSession.run(executor, opts, async (session) => {
      const call = (batch: readonly PayRequest[]): Invocation => ({
        contract: instance.address,
        fn: 'execute_batch',
        args: [
          address('caller', session.address),
          vec(batch.map((i) => bytes32('payoutId', i.payoutId as unknown as Bytes32))),
        ],
      });
      const port: BatchSimulationPort<PayRequest> = {
        simulate: (batch) => this.#simulateExecuteBatch(call(batch), opts),
      };
      const plan = await planBatch(due, port, { maxBisectRounds: this.#c.maxBisectRounds });
      for (const alert of plan.alerts) {
        ports.alerts.batch({
          network,
          kind: alert.kind,
          scope: req.scope,
          payoutId: alert.kind === 'agent_removed' ? alert.item.payoutId : null,
          correlationId: opts.correlationId,
        });
      }
      for (const { item, error } of plan.failed) {
        steps.set(item.payoutId, { kind: 'item_failed', error: error.toJSON() });
      }
      // Deferred items keep whatever step they had; the next call plans them again.
      for (const batch of plan.batches) {
        const inv = call(batch);
        const build = {
          network,
          source: session.address,
          sequence: session.sequence,
          maxTime: ports.clock.nowSeconds() + BigInt(config.executor.txValiditySeconds),
        };
        const sim = await simulate(rpc, network, invokeTx(inv, build), inv.contract, opts);
        const submission = await this.#assembleAndSend(
          session,
          req.scope,
          inv,
          build,
          sim.result?.auth ?? [],
          { op: 'execute_batch', payoutId: null, attempt: null },
          opts,
        );
        submissions.push(submission);
        for (const item of batch) {
          steps.set(item.payoutId, { kind: 'submitted', op: 'execute', submission });
        }
      }
    });
  }

  async #simulateExecuteBatch(inv: Invocation, opts: CallOptions): Promise<BatchSimulation> {
    const { network, rpc } = this.#c;
    const raw = await rpc.simulateTransaction(readTx(network, inv).toXdr(), opts);
    const failure = (raw as { readonly error?: string }).error;
    if (failure === undefined) return { ok: true };
    const events = raw.events ?? [];
    if (isEventsLimitFailure(failure, events)) return { ok: false, kind: 'events_limit' };
    const mapped: ChainAdapterError = callFailure(network, inv.contract, events);
    return mapped instanceof MandateRuleError
      ? { ok: false, kind: 'refused', error: mapped }
      : { ok: false, kind: 'error', error: mapped };
  }

  // -------------------------------------------------------------------------
  // Reads

  async status(req: StatusRequest, opts: CallOptions): Promise<PayoutChainStatus> {
    const { network, rpc, ports } = this.#c;
    const instance = await this.#c.verify(req.scope, req.mandate, opts);
    const [view, latest] = await Promise.all([
      this.#view(instance.address, req.payoutId, opts),
      rpc.getLatestLedger(opts),
    ]);
    const legs: LegDeliveryStatus[] = [];
    for (const legKey of req.legs) {
      const delivery = await ports.store.liveDelivery(req.scope, legKey);
      if (delivery === null) continue;
      legs.push({
        legKey,
        rail: delivery.rail,
        state: delivery.state,
        updatedAt: delivery.updatedAt,
      });
    }
    const base = {
      payoutId: req.payoutId,
      network,
      legs,
      observedAt: {
        ledgerOrBlock: BigInt(latest.sequence),
        time: latest.closeTime as UnixSeconds,
      },
    };
    if (view.kind === 'absent') {
      return { ...base, onChain: 'absent', finality: 'none', lapsed: false };
    }
    if (view.kind === 'closed') {
      const executed =
        view.status === 'executed'
          ? await this.#executed(req.scope, instance.address, req.payoutId, opts)
          : null;
      return {
        ...base,
        onChain: view.status,
        finality: 'final',
        lapsed: false,
        ...(executed === null
          ? {}
          : {
              receipt: formatReceiptRef({
                network,
                txHash: executed.txHash,
                eventIndex: executed.eventIndex,
              }),
            }),
      };
    }
    const pending = view.status === 'pending';
    const required = pending
      ? (await this.#mandateConfig(instance, opts)).config.approvalsRequired
      : 0;
    return {
      ...base,
      onChain: view.status,
      finality: 'final',
      lapsed: latest.closeTime >= view.expiresAt,
      ...(pending ? { approvals: { count: view.approvals, required } } : {}),
    };
  }

  async cancelLapsed(req: CancelLapsedRequest, opts: CallOptions): Promise<CancelLapsedStep> {
    const { network, rpc, ports, executor } = this.#c;
    const instance = await this.#c.verify(req.scope, req.mandate, opts);
    // A cancel that may still land is reconciled first, like any other submission.
    const live = await ports.store.liveSubmission({
      scope: req.scope,
      network,
      mandate: instance.address,
      payoutId: req.payoutId,
      op: 'cancel',
    });
    if (live !== null) {
      const { state } = await reconcileSubmission(executor, live, opts);
      if (isLiveSubmission(state)) {
        return {
          kind: 'submitted',
          submission: { network, txHash: live.txHash, finality: 'none' },
        };
      }
    }
    const view = await this.#view(instance.address, req.payoutId, opts);
    if (view.kind === 'absent') return { kind: 'absent' };
    if (view.kind === 'closed') {
      return view.status === 'cancelled'
        ? { kind: 'cancelled', final: true }
        : { kind: 'closed', status: view.status };
    }
    if ((await this.#now(opts)) < view.expiresAt) return { kind: 'not_lapsed' };
    const config = this.#c.config();
    const submission = await ExecutorSession.run(executor, opts, async (session) => {
      const inv: Invocation = {
        contract: instance.address,
        fn: 'cancel',
        args: [address('caller', session.address), bytes32('payoutId', req.payoutId)],
      };
      const build = {
        network,
        source: session.address,
        sequence: session.sequence,
        maxTime: ports.clock.nowSeconds() + BigInt(config.executor.txValiditySeconds),
      };
      const sim = await simulate(rpc, network, invokeTx(inv, build), inv.contract, opts);
      return this.#assembleAndSend(
        session,
        req.scope,
        inv,
        build,
        sim.result?.auth ?? [],
        { op: 'cancel', payoutId: req.payoutId, attempt: null },
        opts,
      );
    });
    return { kind: 'submitted', submission };
  }

  async proveDead(req: ProveDeadRequest, opts: CallOptions): Promise<DeadProof | null> {
    const { network, rpc } = this.#c;
    const instance = await this.#c.verify(req.scope, req.mandate, opts);
    const view = await this.#view(instance.address, req.payoutId, opts);
    if (view.kind === 'absent') return this.#deadlineProof(req.deadline, opts);
    if (view.kind === 'closed') {
      return view.status === 'executed' ? null : this.#tombstone(view.status, opts);
    }
    const latest = await rpc.getLatestLedger(opts);
    const at = { ledgerOrBlock: BigInt(latest.sequence), finality: 'final' as const };
    if (latest.closeTime >= view.expiresAt) {
      return {
        kind: 'payout_lapsed',
        network,
        expiresAt: view.expiresAt,
        finalTime: latest.closeTime as UnixSeconds,
        at,
      };
    }
    // Asking the mandate is the only proof: the agent may have been removed and
    // added back, which a list of current agents would not show.
    const [key] = this.#c.config().executor.keys;
    if (key === undefined || view.status !== 'approved') return null;
    const inv: Invocation = {
      contract: instance.address,
      fn: 'execute',
      args: [address('caller', key.address), bytes32('payoutId', req.payoutId)],
    };
    const raw = await rpc.simulateTransaction(readTx(network, inv).toXdr(), opts);
    if ((raw as { readonly error?: string }).error === undefined) return null;
    const failure = callFailure(network, inv.contract, raw.events ?? []);
    return failure instanceof MandateRuleError && failure.specName === 'AGENT_REMOVED'
      ? { kind: 'agent_removed', network, at }
      : null;
  }

  async receipt(req: ReceiptRequest, opts: CallOptions): Promise<ChainReceipt> {
    const { network } = this.#c;
    const instance = await this.#c.verify(req.scope, req.mandate, opts);
    const found = await this.#executed(req.scope, instance.address, req.payoutId, opts);
    if (found === null) throw invalid(network, 'payoutId (not_executed)');
    return this.#receiptOf(found, req.mandate, req.payoutId, opts);
  }

  async verifyReceipt(ref: ReceiptRef, opts: CallOptions): Promise<ReceiptVerification> {
    const { network, rpc } = this.#c;
    const parts = parseReceiptRef(ref);
    if (parts.network !== network) return { ok: false, reason: 'not_found' };
    const tx = await rpc.getTransaction(parts.txHash, opts);
    if (tx.status === 'NOT_FOUND') return { ok: false, reason: 'outside_rpc_retention' };
    if (tx.status !== 'SUCCESS' || tx.ledger === undefined) {
      return { ok: false, reason: 'mismatch' };
    }
    const page = await rpc.getEvents(
      {
        startLedger: tx.ledger,
        limit: 1000,
        filter: { topics: [[sym('payout_executed').toXdr('base64'), '*']] },
      },
      opts,
    );
    const event = page.events
      .map((raw) => ledgerEventOf(network, raw))
      .find((e) => e.txHash === parts.txHash && e.eventIndex === BigInt(parts.eventIndex));
    if (event?.name !== 'payout_executed' || event.key === null || event.fields === null) {
      return { ok: false, reason: 'mismatch' };
    }
    const mandate: MandateRef = {
      network,
      address: { network, value: event.contractId },
      specVersion: 1,
    };
    return {
      ok: true,
      receipt: await this.#receiptOf(
        {
          txHash: event.txHash,
          eventIndex: parts.eventIndex,
          ledger: event.ledger,
          closedAt: event.closedAt,
          fields: event.fields,
          feeCharged: null,
        },
        mandate,
        event.key as unknown as PayoutId,
        opts,
      ),
    };
  }

  /** From the chain's own event while the RPC holds it, then the indexer's copy of it. */
  async #executed(
    scope: TenantScope,
    mandate: string,
    payoutId: PayoutId,
    opts: CallOptions,
  ): Promise<MirroredExecution | null> {
    const { network, rpc, ports, mirror } = this.#c;
    const stored = await ports.store.landedSubmission({ scope, network, mandate, payoutId });
    const latest = await rpc.getLatestLedger(opts);
    const startLedger =
      stored?.landedAtHeight === null || stored === null
        ? Math.max(latest.sequence - RECEIPT_SCAN_LEDGERS, 1)
        : Number(stored.landedAtHeight);
    try {
      const page = await rpc.getEvents(
        {
          startLedger,
          limit: 100,
          filter: {
            contractIds: [mandate],
            topics: [
              [
                sym('payout_executed').toXdr('base64'),
                bytes32('payoutId', payoutId).toXdr('base64'),
              ],
            ],
          },
        },
        opts,
      );
      for (const raw of page.events) {
        const event = ledgerEventOf(network, raw);
        // The filter is the node's word. The source and the outcome are read
        // again here, because a receipt is what a principal is shown as proof.
        if (
          event.contractId === mandate &&
          event.type === 'contract' &&
          event.successful &&
          event.name === 'payout_executed' &&
          event.key === (payoutId as unknown as Bytes32) &&
          event.fields !== null
        ) {
          return {
            txHash: event.txHash,
            eventIndex: Number(event.eventIndex),
            ledger: event.ledger,
            closedAt: event.closedAt,
            fields: event.fields,
            feeCharged: null,
          };
        }
      }
    } catch (error) {
      // A start outside the RPC's window reads as an endpoint error. The copy
      // below is what exists for that case, so only an outage with no copy shows.
      if (!(error instanceof ChainUnavailableError) || mirror === null) throw error;
    }
    return mirror === null ? null : mirror.executed(scope, mandate, payoutId, opts);
  }

  async #receiptOf(
    found: MirroredExecution,
    mandate: MandateRef,
    payoutId: PayoutId,
    opts: CallOptions,
  ): Promise<ChainReceipt> {
    const { network, rpc } = this.#c;
    const { fields } = found;
    const total = fields['total'];
    const legs = fields['legs'];
    if (typeof total !== 'string' || !Array.isArray(legs)) throw new InternalError({ network });
    const tx = await rpc.getTransaction(found.txHash, opts);
    const fee = found.feeCharged ?? feeChargedOf(tx) ?? 0n;
    return {
      ref: formatReceiptRef({ network, txHash: found.txHash, eventIndex: found.eventIndex }),
      network,
      txHash: found.txHash,
      eventIndex: found.eventIndex,
      ledgerOrBlock: found.ledger,
      blockHash: null,
      closedAt: BigInt(Math.floor(new Date(found.closedAt).getTime() / 1000)) as UnixSeconds,
      finality: 'final',
      mandate,
      payoutId,
      total: tokenAmount(BigInt(total), 'USDC', 'stellar'),
      legs: (legs as readonly EventJson[]).map((leg, index) => this.#receiptLeg(leg, index)),
      networkFee: { network, asset: 'XLM', amount: fee, scale: 7 },
      explorerUrl: this.#c.config().explorer.tx.replace('{hash}', found.txHash),
    };
  }

  #receiptLeg(leg: EventJson, index: number): ReceiptLeg {
    const { network } = this.#c;
    if (leg === null || typeof leg !== 'object' || Array.isArray(leg)) {
      throw new InternalError({ network });
    }
    const { destination, amount } = leg as Readonly<Record<string, EventJson>>;
    if (typeof destination !== 'string' || typeof amount !== 'string') {
      throw new InternalError({ network });
    }
    const parsed = parseStellarDestination(network, { address: destination });
    return {
      index,
      destination: parsed.address,
      ...(parsed.tag === null ? {} : { tag: parsed.tag }),
      amount: tokenAmount(BigInt(amount), 'USDC', 'stellar'),
    };
  }

  /** Whether `destination` can take `amount` now, as the attester and the request both ask. */
  checkDestination(
    req: {
      readonly destination: Destination;
      readonly amount?: { readonly amount: bigint };
      readonly proofSigner?: string;
    },
    opts: CallOptions,
  ): Promise<DestinationState> {
    return readDestination(
      this.#c.rpc,
      this.#c.config().assets.USDC.issuer,
      {
        destination: req.destination,
        ...(req.amount === undefined ? {} : { amount: req.amount.amount }),
        ...(req.proofSigner === undefined ? {} : { proofSigner: req.proofSigner }),
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Shared reads

  async #view(contract: string, payoutId: PayoutId, opts: CallOptions): Promise<PayoutView> {
    const { network, rpc } = this.#c;
    const inv: Invocation = {
      contract,
      fn: 'payout',
      args: [bytes32('payoutId', payoutId)],
    };
    return payoutViewOf(
      returned(await simulate(rpc, network, readTx(network, inv), contract, opts)),
    );
  }

  async #mandateConfig(instance: MandateInstance, opts: CallOptions) {
    const { network, rpc } = this.#c;
    const call = (fn: string) =>
      simulate(
        rpc,
        network,
        readTx(network, { contract: instance.address, fn, args: [] }),
        instance.address,
        opts,
      );
    const [configSim, stateSim] = await Promise.all([call('config'), call('state')]);
    const state = stateOf(returned(stateSim));
    return {
      config: configViewOf(returned(configSim), {
        network,
        factory: instance.factory,
        policyEpoch: state.policyEpoch,
      }),
      policyEpoch: state.policyEpoch,
    };
  }

  async #now(opts: CallOptions): Promise<UnixSeconds> {
    return (await this.#c.rpc.getLatestLedger(opts)).closeTime as UnixSeconds;
  }

  async #signerAddress(signer: SignerRef, opts: CallOptions): Promise<string> {
    const { network, ports } = this.#c;
    if (signer.network !== network) throw invalid(network, 'signer.network (mismatch)');
    const resolved =
      signer.kind === 'external' ? signer.address : await ports.signer.address(signer, opts);
    if (resolved.network !== network || !/^[GC]/.test(resolved.value)) {
      throw invalid(network, 'signer.address (invalid)');
    }
    return resolved.value;
  }

  async #deadlineProof(deadline: UnixSeconds, opts: CallOptions): Promise<DeadProof | null> {
    const { network, rpc } = this.#c;
    const latest = await rpc.getLatestLedger(opts);
    if (latest.closeTime < deadline) return null;
    return {
      kind: 'deadline_passed',
      network,
      finalTime: latest.closeTime as UnixSeconds,
      at: { ledgerOrBlock: BigInt(latest.sequence), finality: 'final' },
    };
  }

  async #tombstone(status: 'rejected' | 'cancelled', opts: CallOptions): Promise<DeadProof> {
    const { network, rpc } = this.#c;
    const latest = await rpc.getLatestLedger(opts);
    return {
      kind: 'tombstone',
      network,
      status,
      at: { ledgerOrBlock: BigInt(latest.sequence), finality: 'final' },
    };
  }
}
