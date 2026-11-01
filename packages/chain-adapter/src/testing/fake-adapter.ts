// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The chain adapter over the fake network. It behaves as the Stellar
// adapter must: it simulates every call before anything is signed or
// reserved, writes each submission to the store before broadcast, moves
// submissions only forward, reconciles by hash before any retry, and leases
// an executor account per execution. Router, payout and API tests run
// against it, and it passes the same conformance suite the real adapter
// does.
//
// What a real adapter reads from XDR the fake keeps as closures in its
// request book, so a signed payload is checked against the exact request
// the adapter built, and nothing outside this file learns the format.

import { money, moneyAt, tokenAmount } from '@ujira/core';
import type { Chain, TokenAmount } from '@ujira/core';
import { z } from 'zod';

import { isAccountAddress, isContractAddress } from '../codecs/strkey.js';
import type { StellarNetworkConfig } from '../config.js';
import {
  ChainAdapterError,
  ChainUnavailableError,
  InternalError,
  InvalidInputError,
  MandateRuleError,
  MandateUntrustedError,
  QuoteUnavailableError,
  RailUnavailableError,
  ReorgedError,
  RpcLaggingError,
  RpcTimeoutError,
  SignedPayloadMismatchError,
  SignerAddressMismatchError,
  SigningRequestExpiredError,
  SubmissionRejectedError,
  TenantMismatchError,
} from '../errors.js';
import { planBatch } from '../bisect.js';
import type { BatchSimulation, BatchSimulationPort } from '../bisect.js';
import { withSignerHealth } from '../health.js';
import { chainOf } from '../networks.js';
import type { NetworkId } from '../networks.js';
import { formatReceiptRef, parseReceiptRef } from '../receipt-ref.js';
import type { AttestationFields, SignerProvider, SignerRef } from '../signer.js';
import { stellarAttestationMessage } from '../stellar/attestation-message.js';
import { parseStellarDestination } from '../stellar/parse-destination.js';
import { CHAIN_ADAPTER_INTERFACE_VERSION } from '../types.js';
import type {
  AdapterAlerts,
  AdapterCapabilities,
  AdapterStore,
  AllowEntryInput,
  BatchStep,
  Bytes32,
  CallOptions,
  ChainAdapter,
  ChainAddress,
  ChainHealth,
  ChainReceipt,
  DeadProof,
  Deposit,
  DepositScanPage,
  DepositScanRequest,
  Destination,
  ExecutorLease,
  FundingInstructions,
  LegDeliveryStatus,
  LegKey,
  LimitsInput,
  MandateAction,
  MandateActionRequest,
  MandateConfigInput,
  MandateConfigView,
  MandateRef,
  MandateSnapshot,
  NativeAmount,
  OnChainPayoutState,
  PayBatchRequest,
  PayRequest,
  PayStep,
  PayoutChainStatus,
  PayoutId,
  PrepareFundingRequest,
  ProveDeadRequest,
  Quote,
  QuoteRequest,
  RawDestination,
  ReceiptRef,
  ReceiptRequest,
  ReceiptVerification,
  RoleName,
  SignedSubmission,
  SigningRequest,
  SigningSummary,
  SponsoredIntent,
  SponsorshipPolicy,
  StatusRequest,
  SubmissionOp,
  SubmissionPatch,
  SubmissionRecord,
  SubmissionRef,
  SubmissionState,
  TenantScope,
  UnixSeconds,
} from '../types.js';

import { accountAddress, accountFromSeed, accountKeyOf } from './address.js';
import { ed25519Sign, ed25519Verify, hexOf, sha256, utf8 } from './bytes.js';
import type { MandateEngine } from './engine.js';
import {
  HostAbort,
  HostAuthFailure,
  NestedCallRefused,
  TokenFailure,
  TransportFailure,
  refusal,
} from './failures.js';
import { FAKE_TX_FEE, tenantRefOf } from './fake-network.js';
import type { FakeNetwork, FakeTx, StoredRequest } from './fake-network.js';
import { SimulatedCrash } from './faults.js';
import { feeCap } from './rules.js';
import { ROLE } from './spec.js';
import type {
  EngineConfig,
  EngineDestination,
  EngineLimits,
  EnginePayoutRecord,
  EnginePayoutRequest,
} from './types.js';

/** The fake's stand-in for the host's resource limit on contract events. */
class EventsLimitExceeded extends Error {
  override readonly name = 'EventsLimitExceeded';
}

/** How hard the batch planner may search for offenders in one step. */
export interface FakeChainAdapterOptions {
  readonly maxBisectRounds?: number;
}

/** The ports the fake takes; its clock and config come from the network. */
export interface FakeChainAdapterPorts {
  readonly store: AdapterStore;
  readonly signer: SignerProvider;
  readonly sponsorship: SponsorshipPolicy;
  readonly alerts: AdapterAlerts;
}

const ROLE_CODES: Readonly<Record<RoleName, number>> = Object.freeze({
  agent: ROLE.AGENT,
  approver: ROLE.APPROVER,
  guardian: ROLE.GUARDIAN,
  executor: ROLE.EXECUTOR,
  recovery: ROLE.RECOVERY,
});

const MODES = Object.freeze({
  allowlist: 'ALLOWLIST',
  attested: 'ATTESTED',
  both: 'BOTH',
} as const);

const SPONSORED: Readonly<Partial<Record<SubmissionOp, SponsoredIntent>>> = Object.freeze({
  create: 'create_mandate',
  pause: 'pause',
  resume: 'resume',
  revoke: 'revoke',
  approve: 'approve',
  reject: 'reject',
  cancel: 'cancel',
  cancel_batch: 'cancel',
  withdraw: 'withdraw',
  fund: 'fund',
});

// The settlement asset as the adapter accepts it: USDC on Stellar at its
// on-chain scale, nothing else.
const USDC_AMOUNT = z.object({
  kind: z.literal('token'),
  amount: z.bigint(),
  asset: z.literal('USDC'),
  chain: z.literal('stellar'),
  scale: z.literal(7),
});

const SIGNED_PREFIX = 'fake-signed:v1:';
const SIGNATURE_HEX = /^0x(?:[0-9a-f]{2}){64}$/;
const QUOTE_SECONDS = 60n;
const ANCHOR_PROVIDER_PREFIX = 'anchor-tx:';

/**
 * Signs a request the fake adapter built, as a member's own wallet would.
 * Test code only: the seed is a test key.
 */
export function signFakeRequest(request: SigningRequest, seed: Uint8Array): string {
  const payload = payloadOf(request);
  const signer = accountFromSeed(seed);
  return `${SIGNED_PREFIX}${payload}:${signer}:${hexOf(ed25519Sign(seed, utf8(payload)))}`;
}

function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId;
}

function invalid(issue: string, network: NetworkId | null = null): InvalidInputError {
  return new InvalidInputError({ network, issues: [issue] });
}

function txHashOf(xdr: string, signature: string): string {
  return hexOf(sha256(utf8(`${xdr}|${signature}`))).slice(2);
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

interface Pending {
  readonly record: SubmissionRecord;
  state: SubmissionState;
  readonly run: () => unknown;
  readonly reservationId: string | null;
}

interface SubmitParams {
  readonly scope: TenantScope;
  readonly op: SubmissionOp;
  readonly mandate: string | null;
  readonly payoutId: PayoutId | null;
  readonly attempt: number | null;
  readonly signerAddress: string;
  readonly sequenceOrNonce: bigint;
  readonly maxTime: UnixSeconds | null;
  readonly xdr: string;
  readonly signature: string;
  readonly correlationId: string;
  readonly reservationId: string | null;
  readonly run: () => unknown;
}

interface RequestParams {
  readonly scope: TenantScope;
  readonly signer: SignerRef;
  readonly signerAddress: string;
  readonly op: SubmissionOp;
  readonly mandate: string | null;
  readonly mandateRef: MandateRef | undefined;
  readonly payoutId: PayoutId | null;
  readonly attempt: number | null;
  readonly summary: Omit<SigningSummary, 'feePaidBy'>;
  readonly run: (caller: string) => unknown;
}

export class FakeChainAdapter implements ChainAdapter {
  readonly interfaceVersion = CHAIN_ADAPTER_INTERFACE_VERSION;
  readonly network: NetworkId;
  readonly chain: Chain;
  readonly #net: FakeNetwork;
  readonly #store: AdapterStore;
  readonly #signer: SignerProvider;
  readonly #sponsorship: SponsorshipPolicy;
  readonly #alerts: AdapterAlerts;
  /** Submissions this process sent, so a replayed signed payload finds its own. */
  readonly #sent = new Map<string, Pending>();
  readonly #maxBisectRounds: number;

  constructor(
    net: FakeNetwork,
    ports: FakeChainAdapterPorts,
    options: FakeChainAdapterOptions = {},
  ) {
    this.#maxBisectRounds = options.maxBisectRounds ?? 16;
    this.network = net.network;
    this.chain = chainOf(net.network);
    this.#net = net;
    this.#store = ports.store;
    this.#signer = ports.signer;
    this.#sponsorship = ports.sponsorship;
    this.#alerts = ports.alerts;
  }

  // -------------------------------------------------------------------------
  // Identity, health and parsing

  capabilities(): AdapterCapabilities {
    const anchor = this.#net.faults.anchor;
    return {
      network: this.network,
      specVersions: [1],
      settlementAssets: ['USDC'],
      rails: [
        {
          rail: 'stellar.wallet',
          enabled: true,
          deliveryCurrencies: ['USDC'],
          countries: [],
          firmQuotes: true,
          requiresRecipientKyc: false,
        },
        {
          rail: 'stellar.sep31',
          enabled: anchor !== null,
          deliveryCurrencies: anchor === null ? [] : [anchor.currency],
          countries: anchor === null ? [] : [anchor.country],
          firmQuotes: true,
          requiresRecipientKyc: true,
        },
      ],
      maxLegs: 4,
      maxBatch: 10,
      supportsDestinationTag: true,
      typicalSettlementSeconds: 5,
      typicalFinalSeconds: 5,
    };
  }

  async health(opts: CallOptions): Promise<ChainHealth> {
    const faults = this.#net.faults;
    const down = faults.isChainDown();
    const lag = faults.lagSeconds;
    const lagging = lag > this.#config().health.maxHeadLagSeconds;
    const state = down ? 'down' : lagging ? 'degraded' : 'healthy';
    const reasons = down ? ['RPC_ERRORS'] : lagging ? ['HEAD_LAG'] : [];
    const signer = await this.#signer.health(opts);
    return withSignerHealth(
      {
        network: this.network,
        state,
        checkedAt: this.#now(),
        headLagSeconds: lag,
        rpcP95Ms: 50,
        submitSuccessRate5m: this.#successRate(),
        sponsorFunded: true,
        executorFunded: true,
        rails: [
          { rail: 'stellar.wallet', state },
          faults.anchor === null
            ? { rail: 'stellar.sep31', state: 'down', reason: 'NOT_CONFIGURED' }
            : { rail: 'stellar.sep31', state },
        ],
        reasons,
      },
      signer,
    );
  }

  parseAddress(raw: string): ChainAddress {
    const text: unknown = raw;
    if (typeof text !== 'string' || !(isAccountAddress(text) || isContractAddress(text))) {
      throw invalid('address (invalid)', this.network);
    }
    return { network: this.network, value: text };
  }

  parseDestination(raw: RawDestination): Destination {
    return parseStellarDestination(this.network, raw);
  }

  attestationMessage(fields: AttestationFields): Uint8Array {
    if (fields.mandate.network !== this.network) {
      throw invalid('mandate.network (mismatch)', this.network);
    }
    return stellarAttestationMessage(fields);
  }

  // -------------------------------------------------------------------------
  // Mandates

  readMandate(
    req: { readonly scope: TenantScope; readonly mandate: MandateRef },
    opts: CallOptions,
  ): Promise<MandateSnapshot> {
    return this.#traced('readMandate', () => {
      this.#reach(opts);
      this.#fresh();
      const engine = this.#mandate(req.scope, req.mandate, false);
      const c = engine.config();
      const s = engine.state();
      return Promise.resolve({
        mandate: req.mandate,
        trustedFactory: this.#trusted(engine),
        tenantRefMatches: true,
        asset: 'USDC',
        config: this.#configView(c, s.policyEpoch),
        state: {
          spent: this.#token(s.spent),
          pending: this.#token(s.pending),
          committed: this.#token(s.committed),
          balance: this.#token(s.balance),
          free: this.#token(s.free),
          paused: s.paused,
          revoked: s.revoked,
          expired: s.expired,
          policyEpoch: Number(s.policyEpoch),
        },
        observedAt: {
          ledgerOrBlock: this.#net.head,
          time: this.#now(),
          finality: this.#net.finalityDepth === 0 ? 'final' : 'included',
        },
      });
    });
  }

  prepareMandateAction(req: MandateActionRequest, opts: CallOptions): Promise<SigningRequest> {
    return this.#traced(`prepare ${req.action.op}`, async () => {
      this.#reach(opts);
      const { action } = req;
      let run: (caller: string) => unknown;
      let mandate: string;
      if (action.op === 'create') {
        if (req.mandate !== null) throw invalid('mandate (not_null)', this.network);
        const config = this.#engineConfig(action.config);
        run = (caller) => this.#net.factory.create({ caller }, config, action.salt);
        mandate = this.#net.factory.mandateAddress(action.config.principal.value, action.salt);
      } else {
        if (req.mandate === null) throw invalid('mandate (required)', this.network);
        const engine = this.#mandate(req.scope, req.mandate, true);
        run = this.#actionRun(action, engine);
        mandate = engine.address;
      }
      const signerAddress = await this.#signerAddress(req.signer, opts);
      this.#simulate(() => run(signerAddress));
      return this.#request({
        scope: req.scope,
        signer: req.signer,
        signerAddress,
        op: action.op,
        mandate,
        mandateRef: req.mandate ?? undefined,
        payoutId: 'payoutId' in action ? action.payoutId : null,
        attempt: null,
        summary: this.#actionSummary(action, req.mandate),
        run,
      });
    });
  }

  submitSigned(req: SignedSubmission, opts: CallOptions): Promise<SubmissionRef> {
    return this.#traced('submitSigned', async () => {
      this.#reach(opts);
      const stored = this.#net.requests.get(req.requestId);
      if (stored === undefined) throw invalid('requestId (not_found)', this.network);
      if (!sameScope(stored.scope, req.scope))
        throw new TenantMismatchError({ network: this.network });
      if (stored.submittedAs !== null) return await this.#replay(stored, req.signed);
      if (this.#now() > stored.validUntil) {
        await this.#releaseReservation(stored.scope, stored.reservationId);
        throw new SigningRequestExpiredError({ network: this.network });
      }
      const signature = await this.#verifySigned(stored, req.signed, opts);
      const xdr = payloadOf(stored.request);
      const txHash = txHashOf(xdr, signature);
      stored.submittedAs = req.signed;
      stored.txHash = txHash;
      const submitted = this.#submit({
        scope: stored.scope,
        op: stored.op,
        mandate: stored.mandate,
        payoutId: stored.payoutId as PayoutId | null,
        attempt: stored.attempt,
        signerAddress: stored.request.signer.value,
        sequenceOrNonce: stored.sequenceOrNonce,
        maxTime: stored.validUntil,
        xdr,
        signature,
        correlationId: req.correlationId,
        reservationId: stored.reservationId,
        run: () => stored.run(stored.request.signer.value),
      });
      try {
        return await submitted;
      } catch (error) {
        // Refused before it was recorded, so the request can be signed again.
        if (!this.#sent.has(txHash)) {
          stored.submittedAs = null;
          stored.txHash = null;
        }
        throw error;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Funding and deposits

  fundingInstructions(
    req: { readonly scope: TenantScope; readonly mandate: MandateRef },
    opts: CallOptions,
  ): Promise<FundingInstructions> {
    return this.#traced('fundingInstructions', () => {
      this.#reach(opts);
      this.#mandate(req.scope, req.mandate, true);
      return Promise.resolve({
        mandate: req.mandate,
        address: req.mandate.address,
        asset: 'USDC',
        assetContract: this.#net.token.address,
        label: 'USDC on Stellar',
        memoRequired: false,
        warnings: ['other_assets_not_credited', 'wrong_network_lost'],
        availableAt: this.#config().deposits.availableAt,
      });
    });
  }

  prepareFunding(req: PrepareFundingRequest, opts: CallOptions): Promise<SigningRequest> {
    return this.#traced('prepareFunding', async () => {
      this.#reach(opts);
      const engine = this.#mandate(req.scope, req.mandate, true);
      const from = this.parseAddress(req.from.value).value;
      const amount = this.#units(req.amount, 'amount');
      if (amount < 1n) throw invalid('amount (not_positive)', this.network);
      const to = { address: engine.address, tag: null };
      const run = (caller: string): unknown => this.#net.token.transfer(caller, to, amount);
      this.#simulate(() => run(from));
      return this.#request({
        scope: req.scope,
        signer: { kind: 'external', network: this.network, role: 'principal', address: req.from },
        signerAddress: from,
        op: 'fund',
        mandate: engine.address,
        mandateRef: req.mandate,
        payoutId: null,
        attempt: null,
        summary: { action: 'fund', mandate: req.mandate, amount: req.amount },
        run,
      });
    });
  }

  scanDeposits(req: DepositScanRequest, opts: CallOptions): Promise<DepositScanPage> {
    return this.#traced('scanDeposits', async () => {
      this.#reach(opts);
      if (!Number.isSafeInteger(req.limit) || req.limit < 1 || req.limit > 1000) {
        throw invalid('limit (invalid)', this.network);
      }
      const { position, drops } = this.#cursor(req.cursor);
      const all = this.#net.deposits;
      const deposits: Deposit[] = [];
      let at = position;
      while (at < all.length && deposits.length < req.limit) {
        const d = all[at];
        at += 1;
        if (d?.droppedAs !== null) continue;
        const watched = await req.isWatched({ network: this.network, value: d.to });
        if (watched === null) continue;
        const usdc = d.token === this.#net.token.address;
        deposits.push({
          scope: watched.scope,
          mandate: watched.mandate,
          txHash: d.txHash,
          eventIndex: d.eventIndex,
          from: d.from === null ? null : { network: this.network, value: d.from },
          asset: usdc ? 'USDC' : 'other',
          tokenContract: d.token,
          amount: usdc ? this.#token(d.amount) : { amount: d.amount, scale: 7 },
          ledgerOrBlock: d.ledger,
          blockHash: null,
          closedAt: d.closedAt as UnixSeconds,
          finality: this.#net.isFinal(d.ledger) ? 'final' : 'included',
        });
      }
      const gone = all.filter(
        (d) => d.droppedAs !== null && d.droppedAs >= drops && all.indexOf(d) < position,
      );
      const seenDrops = all.reduce((n, d) => (d.droppedAs === null ? n : n + 1), 0);
      return {
        deposits,
        nextCursor: `fake:v1:${String(at)}:${String(seenDrops)}`,
        head: {
          ledgerOrBlock: this.#net.head,
          safe: this.#net.finalHead,
          final: this.#net.finalHead,
        },
        reorged: gone.map((d) => ({ txHash: d.txHash, eventIndex: d.eventIndex })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Quotes

  quote(req: QuoteRequest, opts: CallOptions): Promise<Quote> {
    return this.#traced<Quote>('quote', () => {
      this.#reach(opts);
      const id = this.#net.nextId('quote') as Quote['id'];
      const expiresAt = (this.#now() + QUOTE_SECONDS) as UnixSeconds;
      if (req.rail === 'stellar.wallet') {
        if (req.buy.currency !== 'USDC' || req.amount.side !== 'sell') {
          throw new QuoteUnavailableError({ network: this.network });
        }
        const sell = this.#units(req.amount.value, 'amount.value');
        return Promise.resolve({
          id,
          network: this.network,
          rail: req.rail,
          source: 'par',
          firm: true,
          sell: this.#token(sell),
          buy: moneyAt(sell, 'USD', 7),
          fees: [],
          price: { numerator: 1n, denominator: 1n },
          expiresAt,
        });
      }
      const anchor = this.#net.faults.anchor;
      if (anchor === null) throw new RailUnavailableError({ network: this.network });
      if (req.buy.currency !== anchor.currency || req.country !== anchor.country) {
        throw new QuoteUnavailableError({ network: this.network });
      }
      const { numerator, denominator } = anchor.rate;
      let sell: bigint;
      let buy: bigint;
      if (req.amount.side === 'sell') {
        sell = this.#units(req.amount.value, 'amount.value');
        if (sell <= anchor.fee) throw new QuoteUnavailableError({ network: this.network });
        buy = ((sell - anchor.fee) * numerator) / denominator;
      } else {
        const wanted = req.amount.value;
        const minor = money(0n, anchor.currency).scale;
        if (wanted.currency !== anchor.currency || wanted.scale !== minor || wanted.amount < 1n) {
          throw invalid('amount.value (invalid)', this.network);
        }
        buy = wanted.amount;
        sell = (buy * denominator + numerator - 1n) / numerator + anchor.fee;
      }
      return Promise.resolve({
        id,
        network: this.network,
        rail: req.rail,
        source: 'sep38',
        firm: req.firm,
        sell: this.#token(sell),
        buy: money(buy, anchor.currency),
        fees: [{ kind: 'anchor', amount: this.#token(anchor.fee), paidBy: 'recipient' }],
        price: { numerator, denominator },
        expiresAt,
        providerRef: anchor.anchorId,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Payouts

  pay(req: PayRequest, opts: CallOptions): Promise<PayStep> {
    return this.#traced(`pay ${idText(req.payoutId).slice(2, 10)}`, async () => {
      this.#reach(opts);
      const engine = this.#mandate(req.scope, req.mandate, true);
      this.#checkPay(req);
      for (const op of ['request', 'execute'] as const) {
        const live = await this.#store.liveSubmission({
          scope: req.scope,
          network: this.network,
          mandate: engine.address,
          payoutId: req.payoutId,
          op,
        });
        if (live === null) continue;
        const run = this.#payRun(engine, req, op);
        const settled = await this.#reconcile(live, run);
        if (settled === 'pending') {
          return { kind: 'submitted', op, submission: this.#ref(live.txHash, null) };
        }
      }
      return this.#payStep(engine, req, opts);
    });
  }

  payBatch(req: PayBatchRequest, opts: CallOptions): Promise<BatchStep> {
    return this.#traced('payBatch', async () => {
      this.#reach(opts);
      const engine = this.#mandate(req.scope, req.mandate, true);
      if (req.items.length < 1 || req.items.length > this.capabilities().maxBatch) {
        throw invalid('items (invalid_length)', this.network);
      }
      for (const item of req.items) {
        if (!sameScope(item.scope, req.scope) || item.mandate.address.value !== engine.address) {
          throw invalid('items.mandate (mismatch)', this.network);
        }
        this.#checkPay(item);
      }
      if (new Set(req.items.map((i) => i.payoutId)).size !== req.items.length) {
        throw invalid('items.payoutId (duplicate)', this.network);
      }
      const steps = new Map<PayoutId, BatchStep['items'][number]['step']>();
      const submissions: SubmissionRef[] = [];
      await this.#requestBatch(engine, req, steps, submissions, opts);
      await this.#executeBatch(engine, req, steps, submissions, opts);
      return {
        items: req.items.map((item) => ({
          payoutId: item.payoutId,
          step: steps.get(item.payoutId) ?? this.#settledStep(engine, item),
        })),
        submissions,
      };
    });
  }

  status(req: StatusRequest, opts: CallOptions): Promise<PayoutChainStatus> {
    return this.#traced('status', async () => {
      this.#reach(opts);
      this.#fresh();
      const engine = this.#mandate(req.scope, req.mandate, true);
      const view = engine.payout(req.payoutId);
      const onChain = onChainState(view);
      const now = this.#now();
      const touched = this.#net.lastTouch(req.payoutId);
      const execution = this.#net.execution(req.payoutId);
      const legs: LegDeliveryStatus[] = [];
      for (const legKey of req.legs) {
        const leg = await this.#deliveryStatus(req.scope, legKey, execution?.tx);
        if (leg !== null) legs.push(leg);
      }
      const status: PayoutChainStatus = {
        payoutId: req.payoutId,
        network: this.network,
        onChain,
        finality:
          touched === undefined ? 'none' : this.#net.isFinal(touched.ledger) ? 'final' : 'included',
        lapsed: view !== null && 'expiresAt' in view && now >= view.expiresAt,
        legs,
        observedAt: { ledgerOrBlock: this.#net.head, time: now },
      };
      const approvals =
        view !== null && 'expiresAt' in view && view.status === 'PENDING'
          ? { count: view.approvals.length, required: engine.config().approvalsRequired }
          : undefined;
      return {
        ...status,
        ...(approvals === undefined ? {} : { approvals }),
        ...(execution === undefined
          ? {}
          : { receipt: this.#receiptRef(execution.tx, execution.eventIndex) }),
      };
    });
  }

  proveDead(req: ProveDeadRequest, opts: CallOptions): Promise<DeadProof | null> {
    return this.#traced('proveDead', () => {
      this.#reach(opts);
      this.#fresh();
      const engine = this.#mandate(req.scope, req.mandate, true);
      return Promise.resolve(this.#deadProof(engine, req.payoutId, req.deadline));
    });
  }

  receipt(req: ReceiptRequest, opts: CallOptions): Promise<ChainReceipt> {
    return this.#traced('receipt', () => {
      this.#reach(opts);
      this.#fresh();
      this.#mandate(req.scope, req.mandate, true);
      const found = this.#net.execution(req.payoutId);
      if (found === undefined) {
        if (this.#net.executionDropped(req.payoutId)) {
          this.#alerts.divergence({
            network: this.network,
            kind: 'reorg',
            detail: 'execution_reorged',
            correlationId: opts.correlationId,
          });
          throw new ReorgedError({ network: this.network });
        }
        throw invalid('payoutId (not_executed)', this.network);
      }
      return Promise.resolve(this.#receipt(found.tx, found.eventIndex, req.mandate));
    });
  }

  verifyReceipt(ref: ReceiptRef, opts: CallOptions): Promise<ReceiptVerification> {
    return this.#traced<ReceiptVerification>('verifyReceipt', () => {
      this.#reach(opts);
      const parts = parseReceiptRef(ref);
      if (parts.network !== this.network)
        return Promise.resolve({ ok: false, reason: 'not_found' });
      const tx = this.#net.tx(parts.txHash);
      if (tx === undefined) {
        const dropped = this.#net.droppedTx(parts.txHash) !== undefined;
        if (dropped) {
          this.#alerts.divergence({
            network: this.network,
            kind: 'reorg',
            detail: 'receipt_reorged',
            correlationId: opts.correlationId,
          });
        }
        return Promise.resolve({ ok: false, reason: dropped ? 'reorged' : 'not_found' });
      }
      const event = tx.events[parts.eventIndex];
      if (event?.name !== 'payout_executed') {
        return Promise.resolve({ ok: false, reason: 'mismatch' });
      }
      const mandate: MandateRef = {
        network: this.network,
        address: { network: this.network, value: event.contract },
        specVersion: 1,
      };
      return Promise.resolve({ ok: true, receipt: this.#receipt(tx, parts.eventIndex, mandate) });
    });
  }

  // -------------------------------------------------------------------------
  // The pay step function

  async #payStep(engine: MandateEngine, req: PayRequest, opts: CallOptions): Promise<PayStep> {
    const view = engine.payout(req.payoutId);
    if (view === null) {
      const dead = this.#deadProof(engine, req.payoutId, req.deadline);
      if (dead !== null) return { kind: 'dead', proof: dead };
      return await this.#requestStep(engine, req, opts);
    }
    if (!('expiresAt' in view)) return this.#settledStep(engine, req);
    if (view.total !== this.#units(req.total, 'total')) {
      throw invalid('payoutId (mismatch)', this.network);
    }
    if (view.status === 'PENDING') {
      return {
        kind: 'awaiting_approval',
        approvals: { count: view.approvals.length, required: engine.config().approvalsRequired },
      };
    }
    if (this.#now() >= view.expiresAt) throw this.#rule('PAYOUT_LAPSED');
    if (req.execute === 'hold') return { kind: 'held' };
    return this.#executeStep(engine, req, view, opts);
  }

  async #requestStep(engine: MandateEngine, req: PayRequest, opts: CallOptions): Promise<PayStep> {
    const fee = this.#units(req.fee, 'fee');
    const total = this.#units(req.total, 'total');
    // The cap is checked here first, so a payout the mandate would refuse
    // never costs a signature, a sponsorship reservation or a fee.
    if (fee > feeCap(total, engine.config().maxFeeBps)) throw this.#rule('FEE_EXCEEDS_CAP');
    const run = this.#payRun(engine, req, 'request');
    const signerAddress = await this.#signerAddress(req.signer, opts);
    this.#simulate(() => run(signerAddress));
    await this.#recordDeliveries(req);
    if (req.signer.kind === 'external') {
      const open = [...this.#net.requests.values()].find(
        (r) =>
          r.payoutId === req.payoutId &&
          r.op === 'request' &&
          r.submittedAs === null &&
          sameScope(r.scope, req.scope) &&
          this.#now() <= r.validUntil,
      );
      const request =
        open?.request ??
        (await this.#request({
          scope: req.scope,
          signer: req.signer,
          signerAddress,
          op: 'request',
          mandate: engine.address,
          mandateRef: req.mandate,
          payoutId: req.payoutId,
          attempt: req.attempt,
          summary: { action: 'request_payout', mandate: req.mandate, amount: req.total },
          run,
        }));
      return { kind: 'signature_required', request };
    }
    const submission = await this.#signAndSubmit(
      req.scope,
      req.signer,
      signerAddress,
      { op: 'request', mandate: engine.address, payoutId: req.payoutId, attempt: req.attempt },
      () => run(signerAddress),
      opts,
    );
    return { kind: 'submitted', op: 'request', submission };
  }

  async #executeStep(
    engine: MandateEngine,
    req: PayRequest,
    view: EnginePayoutRecord,
    opts: CallOptions,
  ): Promise<PayStep> {
    // A cap lowered after the request would fail the execution on chain.
    if (view.fee > feeCap(view.total, engine.config().maxFeeBps)) {
      throw this.#rule('FEE_EXCEEDS_CAP');
    }
    const submission = await this.#withExecutor(opts, async (lease, executor, nextSequence) => {
      const run = (): unknown => {
        engine.execute({ caller: executor }, req.payoutId);
        return null;
      };
      this.#simulate(run);
      return this.#signAndSubmit(
        req.scope,
        { kind: 'executor', network: this.network, keyId: lease.keyId },
        executor,
        { op: 'execute', mandate: engine.address, payoutId: req.payoutId, attempt: req.attempt },
        run,
        opts,
        nextSequence(),
      );
    });
    return { kind: 'submitted', op: 'execute', submission };
  }

  #settledStep(engine: MandateEngine, req: PayRequest): PayStep {
    const view = engine.payout(req.payoutId);
    if (view === null) {
      const dead = this.#deadProof(engine, req.payoutId, req.deadline);
      if (dead === null) throw invalid('payoutId (not_requested)', this.network);
      return { kind: 'dead', proof: dead };
    }
    if ('expiresAt' in view) {
      return view.status === 'PENDING'
        ? {
            kind: 'awaiting_approval',
            approvals: {
              count: view.approvals.length,
              required: engine.config().approvalsRequired,
            },
          }
        : { kind: 'held' };
    }
    if (view.status === 'EXECUTED') {
      const found = this.#net.execution(req.payoutId);
      if (found === undefined) throw new ReorgedError({ network: this.network });
      const receipt = this.#receipt(found.tx, found.eventIndex, req.mandate);
      return receipt.finality === 'final'
        ? { kind: 'final', receipt }
        : { kind: 'settled', receipt };
    }
    const dead = this.#deadProof(engine, req.payoutId, req.deadline);
    if (dead !== null) return { kind: 'dead', proof: dead };
    // Rejected or cancelled, but not final yet: the transaction that did it
    // can still be reorganized away, so it is reported as still moving.
    const touched = this.#net.lastTouch(req.payoutId);
    if (touched === undefined) throw new InternalError({ network: this.network });
    return { kind: 'submitted', op: 'request', submission: this.#ref(touched.hash, touched) };
  }

  #deadProof(engine: MandateEngine, payoutId: PayoutId, deadline: UnixSeconds): DeadProof | null {
    const view = engine.payout(payoutId);
    const at = { ledgerOrBlock: this.#net.finalHead, finality: 'final' as const };
    if (view === null) {
      // An absent payout can never be requested once the deadline has
      // passed at a final ledger, since the mandate refuses the request.
      const finalTime = this.#net.finalTime;
      return finalTime >= deadline
        ? {
            kind: 'deadline_passed',
            network: this.network,
            finalTime: finalTime as UnixSeconds,
            at,
          }
        : null;
    }
    if (view.status !== 'REJECTED' && view.status !== 'CANCELLED') return null;
    const touched = this.#net.lastTouch(payoutId);
    if (touched === undefined || !this.#net.isFinal(touched.ledger)) return null;
    return {
      kind: 'tombstone',
      network: this.network,
      status: view.status === 'REJECTED' ? 'rejected' : 'cancelled',
      at,
    };
  }

  #payRun(
    engine: MandateEngine,
    req: PayRequest,
    op: 'request' | 'execute',
  ): (c: string) => unknown {
    if (op === 'execute') {
      return (caller) => {
        engine.execute({ caller }, req.payoutId);
        return null;
      };
    }
    return (caller) => engine.requestPayout({ caller }, this.#engineRequest(engine, req));
  }

  #engineRequest(engine: MandateEngine, req: PayRequest): EnginePayoutRequest {
    const policyEpoch = engine.state().policyEpoch;
    return {
      payoutId: req.payoutId,
      recipientRef: req.recipientRef,
      total: this.#units(req.total, 'total'),
      fee: this.#units(req.fee, 'fee'),
      legs: [...req.legs]
        .sort((a, b) => a.index - b.index)
        .map((leg) => ({
          destination: this.#legDestination(leg.recipientMethodId),
          amount: this.#units(leg.amount, 'legs.amount'),
        })),
      deadline: req.deadline,
      taskRef: req.taskRef,
      attestations: [...req.attestations]
        .sort((a, b) => a.legIndex - b.legIndex)
        .map((a) => ({ validUntil: a.validUntil, policyEpoch, signature: a.signature })),
    };
  }

  #legDestination(methodId: string): EngineDestination {
    const found = this.#method(methodId);
    return { address: found.address.value, tag: found.tag };
  }

  #method(methodId: string): Destination {
    const found = this.#net.recipientMethod(methodId);
    if (found === undefined) throw invalid('legs.recipientMethodId (unknown)', this.network);
    return found;
  }

  #checkPay(req: PayRequest): void {
    const total = this.#units(req.total, 'total');
    if (total < 1n) throw invalid('total (not_positive)', this.network);
    if (this.#units(req.fee, 'fee') < 0n) throw invalid('fee (negative)', this.network);
    if (!Number.isSafeInteger(req.attempt) || req.attempt < 1) {
      throw invalid('attempt (invalid)', this.network);
    }
    const { maxLegs } = this.capabilities();
    if (req.legs.length < 1 || req.legs.length > maxLegs) {
      throw invalid('legs (invalid_length)', this.network);
    }
    let sum = 0n;
    const indexes = new Set<number>();
    for (const leg of req.legs) {
      sum += this.#units(leg.amount, 'legs.amount');
      indexes.add(leg.index);
      const id = idText(req.payoutId);
      if (!leg.legKey.startsWith(id) || leg.legKey.length !== id.length + 2) {
        throw invalid('legs.legKey (mismatch)', this.network);
      }
    }
    if (indexes.size !== req.legs.length || [...indexes].some((i) => i < 0 || i >= maxLegs)) {
      throw invalid('legs.index (invalid)', this.network);
    }
    if (sum !== total) throw invalid('legs (sum_mismatch)', this.network);
  }

  // -------------------------------------------------------------------------
  // Batches

  async #requestBatch(
    engine: MandateEngine,
    req: PayBatchRequest,
    steps: Map<PayoutId, BatchStep['items'][number]['step']>,
    submissions: SubmissionRef[],
    opts: CallOptions,
  ): Promise<void> {
    const absent = req.items.filter(
      (item) => engine.payout(item.payoutId) === null && this.#now() < item.deadline,
    );
    const first = absent[0];
    if (first === undefined) return;
    const signer = first.signer;
    if (absent.some((item) => JSON.stringify(item.signer) !== JSON.stringify(signer))) {
      throw invalid('items.signer (mixed)', this.network);
    }
    const ready: PayRequest[] = [];
    for (const item of absent) {
      const fee = this.#units(item.fee, 'fee');
      if (fee > feeCap(this.#units(item.total, 'total'), engine.config().maxFeeBps)) {
        steps.set(item.payoutId, this.#itemFailed(this.#rule('FEE_EXCEEDS_CAP')));
      } else {
        ready.push(item);
      }
    }
    if (ready.length === 0) return;
    const signerAddress = await this.#signerAddress(signer, opts);
    const requests = ready.map((item) => this.#engineRequest(engine, item));
    const run = (caller: string): unknown => engine.requestPayouts({ caller }, requests);
    const results = this.#simulate(() => run(signerAddress)) as ReturnType<
      MandateEngine['requestPayouts']
    >;
    const accepted = ready.filter((item, i) => {
      const error = results[i]?.error ?? null;
      if (error !== null) steps.set(item.payoutId, this.#itemFailed(this.#rule(error)));
      return error === null;
    });
    if (accepted.length === 0) return;
    for (const item of accepted) await this.#recordDeliveries(item);
    if (signer.kind === 'external') {
      const request = await this.#request({
        scope: req.scope,
        signer,
        signerAddress,
        op: 'request_batch',
        mandate: engine.address,
        mandateRef: req.mandate,
        payoutId: null,
        attempt: null,
        summary: { action: 'request_payouts', mandate: req.mandate },
        run,
      });
      for (const item of accepted)
        steps.set(item.payoutId, { kind: 'signature_required', request });
      return;
    }
    const submission = await this.#signAndSubmit(
      req.scope,
      signer,
      signerAddress,
      { op: 'request_batch', mandate: engine.address, payoutId: null, attempt: null },
      () => run(signerAddress),
      opts,
    );
    submissions.push(submission);
    for (const item of accepted)
      steps.set(item.payoutId, { kind: 'submitted', op: 'request', submission });
  }

  async #executeBatch(
    engine: MandateEngine,
    req: PayBatchRequest,
    steps: Map<PayoutId, BatchStep['items'][number]['step']>,
    submissions: SubmissionRef[],
    opts: CallOptions,
  ): Promise<void> {
    const now = this.#now();
    const due = req.items.filter((item) => {
      const step = steps.get(item.payoutId);
      // An item whose request just landed may execute in the same call.
      const requested = step?.kind === 'submitted' && step.op === 'request';
      if ((step !== undefined && !requested) || item.execute === 'hold') return false;
      const view = engine.payout(item.payoutId);
      return (
        view !== null && 'expiresAt' in view && view.status === 'APPROVED' && now < view.expiresAt
      );
    });
    if (due.length === 0) return;
    await this.#withExecutor(opts, async (lease, executor, nextSequence) => {
      const port: BatchSimulationPort<PayRequest> = {
        simulate: (batch) => Promise.resolve(this.#simulateBatch(engine, executor, batch)),
      };
      const plan = await planBatch(due, port, { maxBisectRounds: this.#maxBisectRounds });
      for (const alert of plan.alerts) {
        this.#alerts.batch({
          network: this.network,
          kind: alert.kind,
          scope: req.scope,
          payoutId: alert.kind === 'agent_removed' ? alert.item.payoutId : null,
          correlationId: opts.correlationId,
        });
      }
      for (const { item, error } of plan.failed) {
        steps.set(item.payoutId, this.#itemFailed(this.#mapFailure(error)));
      }
      // Deferred items keep whatever step they had; the next call plans them again.
      for (const batch of plan.batches) {
        const ids = batch.map((item) => item.payoutId);
        const submission = await this.#signAndSubmit(
          req.scope,
          { kind: 'executor', network: this.network, keyId: lease.keyId },
          executor,
          { op: 'execute_batch', mandate: engine.address, payoutId: null, attempt: null },
          () => {
            engine.executeBatch({ caller: executor }, ids);
            return null;
          },
          opts,
          nextSequence(),
        );
        submissions.push(submission);
        for (const id of ids) steps.set(id, { kind: 'submitted', op: 'execute', submission });
      }
    });
  }

  /** One candidate batch on a throwaway copy of the chain, as the network would simulate it. */
  #simulateBatch(
    engine: MandateEngine,
    executor: string,
    batch: readonly PayRequest[],
  ): BatchSimulation {
    const limit = this.#net.faults.eventsLimit;
    try {
      this.#net.simulate(() => {
        const before = this.#net.ledger.events.length;
        engine.executeBatch(
          { caller: executor },
          batch.map((item) => item.payoutId),
        );
        if (limit !== null && this.#net.ledger.events.length - before > limit) {
          throw new EventsLimitExceeded();
        }
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof EventsLimitExceeded) return { ok: false, kind: 'events_limit' };
      const mapped = this.#mapFailure(error);
      return mapped instanceof MandateRuleError
        ? { ok: false, kind: 'refused', error: mapped }
        : { ok: false, kind: 'error', error: mapped };
    }
  }

  #itemFailed(error: ChainAdapterError): BatchStep['items'][number]['step'] {
    return { kind: 'item_failed', error: error.toJSON() };
  }

  // -------------------------------------------------------------------------
  // Submissions

  async #signAndSubmit(
    scope: TenantScope,
    signer: SignerRef,
    signerAddress: string,
    target: {
      readonly op: SubmissionOp;
      readonly mandate: string;
      readonly payoutId: PayoutId | null;
      readonly attempt: number | null;
    },
    run: () => unknown,
    opts: CallOptions,
    sequence?: bigint,
  ): Promise<SubmissionRef> {
    const sequenceOrNonce = sequence ?? this.#net.nextSequence(signerAddress);
    const maxTime = (this.#now() +
      BigInt(this.#config().executor.txValiditySeconds)) as UnixSeconds;
    const xdr = b64(
      [
        'fake-tx:v1',
        this.network,
        target.op,
        target.mandate,
        target.payoutId ?? '-',
        signerAddress,
        sequenceOrNonce.toString(),
        maxTime.toString(),
      ].join(':'),
    );
    const signature = await this.#signHeld(signer, signerAddress, xdr, opts);
    return this.#submit({
      scope,
      ...target,
      signerAddress,
      sequenceOrNonce,
      maxTime,
      xdr,
      signature,
      correlationId: opts.correlationId,
      reservationId: null,
      run,
    });
  }

  async #signHeld(
    signer: SignerRef,
    signerAddress: string,
    xdr: string,
    opts: CallOptions,
  ): Promise<string> {
    const signed = await this.#signer.sign(
      signer,
      { kind: 'stellar_tx', network: this.network, xdr },
      opts,
    );
    // The port verified the signature against its key; this checks the key
    // is the one the transaction names as its source.
    if (accountAddress(signed.publicKey) !== signerAddress) {
      throw new SignerAddressMismatchError({ network: this.network });
    }
    return hexOf(signed.signature);
  }

  async #submit(p: SubmitParams): Promise<SubmissionRef> {
    const record: SubmissionRecord = {
      scope: p.scope,
      network: this.network,
      txHash: txHashOf(p.xdr, p.signature),
      op: p.op,
      mandate: p.mandate,
      payoutId: p.payoutId,
      attempt: p.attempt,
      signerAddress: p.signerAddress,
      sequenceOrNonce: p.sequenceOrNonce,
      maxTime: p.maxTime,
      state: 'built',
      landedAtHeight: null,
      errorCode: null,
      specCode: null,
      replacesTxHash: null,
      correlationId: p.correlationId,
      createdAt: this.#now(),
    };
    await this.#store.recordSubmission(record);
    const pending: Pending = { record, state: 'built', run: p.run, reservationId: p.reservationId };
    this.#sent.set(record.txHash, pending);
    this.#net.faults.crashPoint('after_record');
    return this.#broadcast(pending);
  }

  async #broadcast(pending: Pending): Promise<SubmissionRef> {
    const { record } = pending;
    // Nothing was sent, so the record stays built and the next step sends
    // the same envelope again.
    if (this.#net.faults.isChainDown()) throw new ChainUnavailableError({ network: this.network });
    await this.#move(pending, 'broadcast');
    if (record.maxTime !== null && this.#now() > record.maxTime) {
      await this.#move(pending, 'expired');
      await this.#releaseReservation(record.scope, pending.reservationId);
      throw new SubmissionRejectedError({ network: this.network });
    }
    const tx = this.#net.include(record.txHash, record.op, record.signerAddress, pending.run);
    this.#net.faults.crashPoint('after_broadcast');
    if (this.#net.faults.takeTimeout()) {
      await this.#move(pending, 'unknown');
      throw new RpcTimeoutError({ network: this.network, landed: 'unknown' });
    }
    return this.#settle(pending, tx);
  }

  /** Records a transaction the chain has: landed, or failed with its mapped error thrown. */
  async #settle(pending: Pending, tx: FakeTx): Promise<SubmissionRef> {
    const { record } = pending;
    if (pending.reservationId !== null) {
      await this.#sponsorship.settle({
        scope: record.scope,
        reservationId: pending.reservationId,
        actualFee: this.#native(FAKE_TX_FEE),
      });
    }
    if (tx.ok) {
      await this.#move(pending, 'landed', { landedAtHeight: tx.ledger });
      return this.#ref(tx.hash, tx);
    }
    const error = this.#mapFailure(tx.error);
    await this.#move(pending, 'failed', {
      landedAtHeight: tx.ledger,
      errorCode: error.code,
      specCode: error instanceof MandateRuleError ? error.specCode : null,
    });
    throw error;
  }

  /**
   * Brings a live submission up to date by hash. Returns 'pending' while it
   * may still land, and 'resolved' once it landed or can never land.
   */
  async #reconcile(
    record: SubmissionRecord,
    run: (caller: string) => unknown,
  ): Promise<'pending' | 'resolved'> {
    const pending: Pending = this.#sent.get(record.txHash) ?? {
      record,
      state: record.state,
      run: () => run(record.signerAddress),
      reservationId: null,
    };
    pending.state = record.state;
    const tx = this.#net.tx(record.txHash);
    if (tx !== undefined) {
      await this.#settle(pending, tx);
      return 'resolved';
    }
    if (record.maxTime !== null && this.#net.finalTime > record.maxTime) {
      await this.#move(pending, 'expired');
      return 'resolved';
    }
    if (record.state === 'built') {
      await this.#broadcast(pending);
      return 'resolved';
    }
    return 'pending';
  }

  async #move(
    pending: Pending,
    to: SubmissionState,
    patch: Omit<SubmissionPatch, 'state'> = {},
  ): Promise<void> {
    const { record } = pending;
    // A record still built when its result is known was sent before the
    // process lost track of it, so it moves through broadcast first.
    if (pending.state === 'built' && to !== 'broadcast') await this.#move(pending, 'broadcast');
    await this.#store.updateSubmission(record.scope, this.network, record.txHash, {
      ...patch,
      state: to,
    });
    pending.state = to;
  }

  /** The same signed payload again: report the submission it already made. */
  async #replay(stored: StoredRequest, signed: string): Promise<SubmissionRef> {
    const txHash = stored.txHash;
    if (signed !== stored.submittedAs || txHash === null) {
      throw new SignedPayloadMismatchError({ network: this.network });
    }
    const tx = this.#net.tx(txHash);
    if (tx !== undefined) {
      if (!tx.ok) throw this.#mapFailure(tx.error);
      return this.#ref(tx.hash, tx);
    }
    const pending = this.#sent.get(txHash);
    if (pending?.state === 'built') return await this.#broadcast(pending);
    return this.#ref(txHash, null);
  }

  async #verifySigned(stored: StoredRequest, signed: string, opts: CallOptions): Promise<string> {
    const xdr = payloadOf(stored.request);
    const signerAddress = stored.request.signer.value;
    if (stored.signer.kind !== 'external') {
      // A key UJIRA holds signs the exact payload it was shown, so the
      // caller submits that payload unchanged and the adapter signs it.
      if (signed !== xdr) throw new SignedPayloadMismatchError({ network: this.network });
      return await this.#signHeld(stored.signer, signerAddress, xdr, opts);
    }
    if (!signed.startsWith(SIGNED_PREFIX)) {
      throw new SignedPayloadMismatchError({ network: this.network });
    }
    const [payload, address, signature] = signed.slice(SIGNED_PREFIX.length).split(':');
    const key = address === undefined ? null : accountKeyOf(address);
    const sig =
      signature !== undefined && SIGNATURE_HEX.test(signature)
        ? Uint8Array.from(Buffer.from(signature.slice(2), 'hex'))
        : null;
    if (
      payload !== xdr ||
      address !== signerAddress ||
      key === null ||
      sig === null ||
      !ed25519Verify(key, utf8(xdr), sig)
    ) {
      throw new SignedPayloadMismatchError({ network: this.network });
    }
    return hexOf(sig);
  }

  async #request(p: RequestParams): Promise<SigningRequest> {
    const config = this.#config();
    const requestId = this.#net.nextId('request');
    const sponsored = p.signer.kind === 'external';
    const reservationId = sponsored ? `sponsor:${this.network}:${requestId}` : null;
    if (reservationId !== null) {
      await this.#sponsorship.reserve({
        scope: p.scope,
        network: this.network,
        reservationId,
        intent: SPONSORED[p.op] ?? 'admin',
        maxFee: this.#native(config.feeSponsor.maxFeePerTxStroops),
      });
    }
    const validUntil = (this.#now() + BigInt(config.signingWindowSeconds)) as UnixSeconds;
    const xdr = b64(`fake-tx:v1:${this.network}:${requestId}:${p.op}:${p.signerAddress}`);
    const request: SigningRequest = {
      kind: 'stellar_transaction',
      network: this.network,
      xdr,
      signer: { network: this.network, value: p.signerAddress },
      validUntil,
      sponsored,
      summary: { ...p.summary, feePaidBy: sponsored ? 'ujira' : 'signer' },
      requestId,
    };
    this.#net.requests.set(requestId, {
      request,
      scope: p.scope,
      signer: p.signer,
      op: p.op,
      mandate: p.mandate,
      payoutId: p.payoutId,
      attempt: p.attempt,
      sequenceOrNonce: this.#net.nextSequence(p.signerAddress),
      validUntil,
      reservationId,
      run: p.run,
      submittedAs: null,
      txHash: null,
    });
    return request;
  }

  async #releaseReservation(scope: TenantScope, reservationId: string | null): Promise<void> {
    if (reservationId !== null) await this.#sponsorship.release({ scope, reservationId });
  }

  /** Leases an executor for one submission and releases it with the next sequence number. */
  async #withExecutor<T>(
    opts: CallOptions,
    body: (lease: ExecutorLease, executor: string, nextSequence: () => bigint) => Promise<T>,
  ): Promise<T> {
    const config = this.#config();
    const lease = await this.#store.leaseExecutor(
      this.network,
      config.executor.txValiditySeconds * 2,
    );
    let next = lease.sequenceOrNonce;
    try {
      const ref: SignerRef = { kind: 'executor', network: this.network, keyId: lease.keyId };
      const executor = (await this.#signer.address(ref, opts)).value;
      if (executor !== lease.address.value) {
        throw new SignerAddressMismatchError({ network: this.network });
      }
      // Each submission takes the next sequence; the release writes back
      // the first one not used.
      const nextSequence = (): bigint => {
        const sequence = next;
        next += 1n;
        return sequence;
      };
      const result = await body(lease, executor, nextSequence);
      await this.#release(lease, next);
      return result;
    } catch (error) {
      // A process that died keeps its lease until it expires, as a real one would.
      if (!(error instanceof SimulatedCrash)) await this.#release(lease, next);
      throw error;
    }
  }

  async #release(lease: ExecutorLease, sequenceOrNonce: bigint): Promise<void> {
    try {
      await this.#store.releaseExecutor(lease, { sequenceOrNonce });
    } catch (error) {
      // The lease was taken over while this job ran. The new holder owns
      // the account now and reads its sequence from the chain, so writing
      // ours back is exactly what the fence exists to stop.
      if (!(error instanceof InvalidInputError && error.issues.includes('lease.leaseId (stale)'))) {
        throw error;
      }
      this.#net.faults.note('lease stale');
    }
  }

  // -------------------------------------------------------------------------
  // Deliveries

  async #recordDeliveries(req: PayRequest): Promise<void> {
    const anchor = this.#net.faults.anchor;
    for (const leg of req.legs) {
      const existing = await this.#store.liveDelivery(req.scope, leg.legKey);
      if (existing !== null) continue;
      const destination = this.#method(leg.recipientMethodId);
      const wallet = leg.rail === 'stellar.wallet';
      if (!wallet && anchor === null) throw new RailUnavailableError({ network: this.network });
      await this.#store.upsertDelivery({
        scope: req.scope,
        legKey: leg.legKey,
        network: this.network,
        rail: leg.rail,
        provider: wallet || anchor === null ? 'wallet' : anchor.anchorId,
        providerRef: wallet ? null : `${ANCHOR_PROVIDER_PREFIX}${leg.legKey}`,
        destination,
        quoteId: leg.quoteId ?? null,
        state: wallet ? 'not_applicable' : 'awaiting_settlement',
        rawStatus: null,
        live: true,
        expiresAt: null,
        updatedAt: this.#now(),
      });
    }
  }

  async #deliveryStatus(
    scope: TenantScope,
    legKey: LegKey,
    executed: FakeTx | undefined,
  ): Promise<LegDeliveryStatus | null> {
    let record = await this.#store.liveDelivery(scope, legKey);
    if (record === null) return null;
    const anchor = this.#net.faults.anchor;
    if (record.rail === 'stellar.sep31' && executed !== undefined && anchor !== null) {
      const elapsed = this.#now() - executed.closedAt;
      const step = anchor.steps.findLast((s) => BigInt(s.afterSeconds) <= elapsed);
      if (step !== undefined && step.state !== record.state) {
        record = {
          ...record,
          state: step.state,
          rawStatus: step.rawStatus,
          updatedAt: this.#now(),
        };
        await this.#store.upsertDelivery(record);
      }
    }
    const provider =
      record.providerRef === null
        ? undefined
        : { id: record.provider, ref: record.providerRef, rawStatus: record.rawStatus ?? '' };
    return {
      legKey,
      rail: record.rail,
      state: record.state,
      ...(provider === undefined ? {} : { provider }),
      updatedAt: record.updatedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Mandate actions

  #actionRun(
    action: Exclude<MandateAction, { readonly op: 'create' }>,
    m: MandateEngine,
  ): (caller: string) => unknown {
    switch (action.op) {
      case 'pause':
        return (caller) => {
          m.pause({ caller });
        };
      case 'resume':
        return (caller) => {
          m.resume({ caller });
        };
      case 'revoke':
        return (caller) => m.revoke({ caller });
      case 'approve':
        return (caller) => m.approve({ caller }, action.payoutId);
      case 'reject':
        return (caller) => {
          m.reject({ caller }, action.payoutId);
        };
      case 'cancel':
        return (caller) => {
          m.cancel({ caller }, action.payoutId);
        };
      case 'cancel_batch':
        return (caller) => m.cancelBatch({ caller }, action.payoutIds);
      case 'withdraw': {
        const amount = this.#units(action.amount, 'action.amount');
        return (caller) => {
          m.withdraw({ caller }, amount);
        };
      }
      case 'sweep':
        return (caller) => m.sweep({ caller });
      case 'recover_token':
        return (caller) => {
          m.recoverToken({ caller }, action.token.value, action.amount);
        };
      case 'update_limits': {
        const limits = this.#engineLimits(action.limits);
        return (caller) => {
          m.updateLimits({ caller }, limits);
        };
      }
      case 'add_role':
        return (caller) => {
          m.addRole({ caller }, ROLE_CODES[action.role], action.account.value);
        };
      case 'remove_role':
        return (caller) => {
          m.removeRole({ caller }, ROLE_CODES[action.role], action.account.value);
        };
      case 'set_approvals_required':
        return (caller) => {
          m.setApprovalsRequired({ caller }, action.n);
        };
      case 'set_recovery_threshold':
        return (caller) => {
          m.setRecoveryThreshold({ caller }, action.n);
        };
      case 'lower_fee_cap':
        return (caller) => {
          m.lowerFeeCap({ caller }, action.maxFeeBps);
        };
      case 'cancel_principal_proposal':
        return (caller) => {
          m.cancelPrincipalProposal({ caller });
        };
      case 'recovery_revoke':
        return (caller) => m.recoveryRevoke({ caller });
      case 'recovery_rotate_agent':
        return (caller) =>
          m.recoveryRotateAgent({ caller }, action.old.value, action.new?.value ?? null);
      case 'allow_recipients':
      case 'disallow_recipients': {
        const entries = action.entries.map((e) => this.#allowEntry(e));
        return action.op === 'allow_recipients'
          ? (caller) => {
              m.allowRecipients({ caller }, entries);
            }
          : (caller) => {
              m.disallowRecipients({ caller }, entries);
            };
      }
      case 'set_attestation_policy':
        return (caller) => {
          m.setAttestationPolicy({ caller }, action.attester, action.countryPolicyHash);
        };
      case 'propose_principal':
        return (caller) => {
          m.proposePrincipal({ caller }, action.proposed.value);
        };
      case 'accept_principal':
        return (caller) => {
          m.acceptPrincipal({ caller });
        };
    }
  }

  #actionSummary(
    action: MandateAction,
    mandate: MandateRef | null,
  ): Omit<SigningSummary, 'feePaidBy'> {
    const base = { action: action.op, ...(mandate === null ? {} : { mandate }) };
    return action.op === 'withdraw' ? { ...base, amount: action.amount } : base;
  }

  #allowEntry(e: AllowEntryInput): { recipientRef: string; destination: EngineDestination } {
    return {
      recipientRef: e.recipientRef,
      destination: { address: e.destination.address.value, tag: e.destination.tag },
    };
  }

  #engineConfig(c: MandateConfigInput): EngineConfig {
    const values = (list: readonly ChainAddress[]): string[] => list.map((a) => a.value);
    return {
      principal: c.principal.value,
      asset: this.#config().assets.USDC.sac,
      recipientMode: MODES[c.recipientMode],
      tenantRef: c.tenantRef,
      agents: values(c.agents),
      approvers: values(c.approvers),
      approvalsRequired: c.approvalsRequired,
      guardians: values(c.guardians),
      executors: values(c.executors),
      recovery: values(c.recovery),
      recoveryThreshold: c.recoveryThreshold,
      limits: this.#engineLimits(c.limits),
      attester: c.attester,
      countryPolicyHash: c.countryPolicyHash,
      maxFeeBps: c.maxFeeBps,
    };
  }

  #engineLimits(l: LimitsInput): EngineLimits {
    return {
      totalBudget: this.#units(l.totalBudget, 'limits.totalBudget'),
      perPaymentCap: this.#units(l.perPaymentCap, 'limits.perPaymentCap'),
      perRecipientDailyCap: this.#units(l.perRecipientDailyCap, 'limits.perRecipientDailyCap'),
      approvalThreshold: this.#units(l.approvalThreshold, 'limits.approvalThreshold'),
      payoutTtlSeconds: BigInt(l.payoutTtlSeconds),
      expiresAt: l.expiresAt,
    };
  }

  #configView(c: ReturnType<MandateEngine['config']>, policyEpoch: bigint): MandateConfigView {
    const address = (value: string): ChainAddress => ({ network: this.network, value });
    const modes = { ALLOWLIST: 'allowlist', ATTESTED: 'attested', BOTH: 'both' } as const;
    return {
      principal: address(c.principal),
      asset: 'USDC',
      recipientMode: modes[c.recipientMode],
      tenantRef: c.tenantRef as Bytes32,
      agents: c.agents.map(address),
      approvers: c.approvers.map(address),
      approvalsRequired: c.approvalsRequired,
      guardians: c.guardians.map(address),
      executors: c.executors.map(address),
      recovery: c.recovery.map(address),
      recoveryThreshold: c.recoveryThreshold,
      limits: {
        totalBudget: this.#token(c.limits.totalBudget),
        perPaymentCap: this.#token(c.limits.perPaymentCap),
        perRecipientDailyCap: this.#token(c.limits.perRecipientDailyCap),
        approvalThreshold: this.#token(c.limits.approvalThreshold),
        payoutTtlSeconds: Number(c.limits.payoutTtlSeconds),
        expiresAt: c.limits.expiresAt as UnixSeconds,
      },
      attester: c.attester,
      countryPolicyHash: c.countryPolicyHash as Bytes32,
      maxFeeBps: c.maxFeeBps,
      factory: address(c.factory),
      feeAddress: address(c.feeAddress),
      policyEpoch: Number(policyEpoch),
      proposedPrincipal: c.proposedPrincipal === null ? null : address(c.proposedPrincipal),
    };
  }

  // -------------------------------------------------------------------------
  // Receipts

  #receipt(tx: FakeTx, eventIndex: number, mandate: MandateRef): ChainReceipt {
    const event = tx.events[eventIndex];
    const fields = event?.fields ?? {};
    const legs = (fields['legs'] ?? []) as readonly {
      readonly destination: { readonly address: string; readonly tag: bigint | null };
      readonly amount: bigint;
    }[];
    return {
      ref: this.#receiptRef(tx, eventIndex),
      network: this.network,
      txHash: tx.hash,
      eventIndex,
      ledgerOrBlock: tx.ledger,
      blockHash: null,
      closedAt: tx.closedAt as UnixSeconds,
      finality: this.#net.isFinal(tx.ledger) ? 'final' : 'included',
      mandate,
      payoutId: fields['payout_id'] as PayoutId,
      total: this.#token(fields['total'] as bigint),
      legs: legs.map((leg, index) => ({
        index,
        destination: { network: this.network, value: leg.destination.address },
        ...(leg.destination.tag === null ? {} : { tag: leg.destination.tag }),
        amount: this.#token(leg.amount),
      })),
      networkFee: this.#native(FAKE_TX_FEE),
      explorerUrl: this.#config().explorer.tx.replace('{hash}', tx.hash),
    };
  }

  #receiptRef(tx: FakeTx, eventIndex: number): ReceiptRef {
    return formatReceiptRef({ network: this.network, txHash: tx.hash, eventIndex });
  }

  #ref(txHash: string, tx: FakeTx | null): SubmissionRef {
    const finality =
      tx === null
        ? 'none'
        : this.#net.isFinal(tx.ledger)
          ? ('final' as const)
          : ('included' as const);
    return { network: this.network, txHash, finality };
  }

  // -------------------------------------------------------------------------
  // Shared checks

  #mandate(scope: TenantScope, ref: MandateRef, mustTrust: boolean): MandateEngine {
    if (ref.network !== this.network || ref.address.network !== this.network) {
      throw invalid('mandate.network (mismatch)', this.network);
    }
    const engine = this.#net.mandate(ref.address.value);
    if (engine === undefined) throw invalid('mandate.address (not_found)', this.network);
    // The tenant check comes first so another tenant learns nothing, not
    // even whether the mandate is trusted.
    if (engine.tenantRef !== tenantRefOf(scope)) {
      throw new TenantMismatchError({ network: this.network });
    }
    if (mustTrust && !this.#trusted(engine)) {
      throw new MandateUntrustedError({ network: this.network });
    }
    return engine;
  }

  #trusted(engine: MandateEngine): boolean {
    return this.#config().trustedFactories['1'].includes(engine.factory);
  }

  async #signerAddress(signer: SignerRef, opts: CallOptions): Promise<string> {
    if (signer.network !== this.network) throw invalid('signer.network (mismatch)', this.network);
    if (signer.kind === 'external') {
      if (signer.address.network !== this.network) {
        throw invalid('signer.address (mismatch)', this.network);
      }
      return this.parseAddress(signer.address.value).value;
    }
    return (await this.#signer.address(signer, opts)).value;
  }

  #simulate<T>(run: () => T): T {
    try {
      return this.#net.simulate(run);
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  /** What a failed call on the fake chain is as an adapter error. */
  #mapFailure(error: unknown): ChainAdapterError {
    const network = this.network;
    if (error instanceof MandateRuleError) {
      return new MandateRuleError(error.specCode, error.specName, { network });
    }
    if (error instanceof ChainAdapterError) return error;
    if (error instanceof TransportFailure)
      return new ChainUnavailableError({ network, cause: error });
    if (
      error instanceof HostAuthFailure ||
      error instanceof HostAbort ||
      error instanceof NestedCallRefused ||
      error instanceof TokenFailure
    ) {
      return new SubmissionRejectedError({ network, cause: error });
    }
    return new InternalError({ network, cause: error });
  }

  #rule(name: Parameters<typeof refusal>[0]): MandateRuleError {
    const base = refusal(name);
    return new MandateRuleError(base.specCode, base.specName, { network: this.network });
  }

  #reach(opts: CallOptions): void {
    if (opts.signal?.aborted === true) {
      throw new RpcTimeoutError({ network: this.network, landed: 'no' });
    }
    if (this.#net.faults.isChainDown()) throw new ChainUnavailableError({ network: this.network });
  }

  #fresh(): void {
    if (this.#net.visibleHead < this.#net.head)
      throw new RpcLaggingError({ network: this.network });
  }

  #config(): StellarNetworkConfig {
    return this.#net.networkConfig;
  }

  #cursor(cursor: string | null): { position: number; drops: number } {
    if (cursor === null) return { position: 0, drops: 0 };
    const match = /^fake:v1:(0|[1-9][0-9]{0,8}):(0|[1-9][0-9]{0,8})$/.exec(cursor);
    if (match === null) throw invalid('cursor (invalid)', this.network);
    return { position: Number(match[1]), drops: Number(match[2]) };
  }

  #successRate(): number | null {
    const since = this.#now() - 300n;
    const recent = this.#net.txs.filter((tx) => tx.closedAt >= since && tx.op !== 'fund');
    if (recent.length === 0) return null;
    const ok = recent.filter((tx) => tx.ok).length;
    return Math.floor((ok * 10_000) / recent.length);
  }

  #units(value: TokenAmount, field: string): bigint {
    const read = USDC_AMOUNT.safeParse(value);
    if (!read.success) throw invalid(`${field} (invalid)`, this.network);
    return read.data.amount;
  }

  #token(amount: bigint): TokenAmount {
    return tokenAmount(amount, 'USDC', this.chain);
  }

  #native(amount: bigint): NativeAmount {
    return { network: this.network, asset: 'XLM', amount, scale: 7 };
  }

  #now(): UnixSeconds {
    return this.#net.now();
  }

  async #traced<T>(label: string, body: () => Promise<T>): Promise<T> {
    const faults = this.#net.faults;
    try {
      const result = await body();
      faults.note(`${label} -> ${outcome(result)}`);
      return result;
    } catch (error) {
      faults.note(
        `${label} -> ${error instanceof ChainAdapterError ? error.code : errorName(error)}`,
      );
      throw error;
    }
  }
}

// PayoutId's two brands collide, so the type reduces to never; reading it
// as a plain string keeps the checks honest until the brand is fixed.
function idText(id: PayoutId): string {
  const text: string = id;
  return text;
}

function payloadOf(request: SigningRequest): string {
  return request.kind === 'stellar_transaction' ? request.xdr : request.entryXdr;
}

function onChainState(view: ReturnType<MandateEngine['payout']>): OnChainPayoutState {
  if (view === null) return 'absent';
  const states = {
    PENDING: 'pending',
    APPROVED: 'approved',
    EXECUTED: 'executed',
    REJECTED: 'rejected',
    CANCELLED: 'cancelled',
  } as const;
  return states[view.status];
}

function outcome(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'kind' in result) {
    const kind: unknown = result.kind;
    if (typeof kind === 'string') return kind;
  }
  return 'ok';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
