// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The chain agnostic interface every network adapter implements. Nothing
// here names an SDK type: callers outside this package see plain strings,
// bigints and core money values only, so a router or payout job can never
// grow a dependency on one chain.
//
// Signing is a separate port with its own types (signer references,
// payloads and results). It is added next to this file when the signer
// service lands, together with the fields that carry a signer below.

import type { Chain, FiatCurrencyCode, Money, TokenAmount, TokenAsset } from '@ujira/core';

import type { ChainAdapterErrorCode, ChainAdapterErrorJson } from './errors.js';
import type { NetworkId } from './networks.js';
import type { NetworksConfig } from './config.js';

export const CHAIN_ADAPTER_INTERFACE_VERSION = 1 as const;

export type RailId =
  | 'stellar.wallet'
  | 'stellar.sep31'
  | 'stellar.moneygram'
  | 'celo.wallet'
  | 'celo.minipay'
  | 'celo.mento_forward';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Uuid = Brand<string, 'Uuid'>;
/** 0x followed by 64 lowercase hex characters. */
export type Bytes32 = Brand<string, 'Bytes32'>;
/** Hash over tenant, idempotency key and attempt. Derived in core only. */
export type PayoutId = Brand<Bytes32, 'PayoutId'>;
/** The payout ID followed by the leg index byte: 0x plus 66 hex characters. */
export type LegKey = Brand<string, 'LegKey'>;
export type QuoteId = Brand<string, 'QuoteId'>;
/** Unix seconds as bigint, matching u64 on both chains. */
export type UnixSeconds = Brand<bigint, 'UnixSeconds'>;
/** ISO 3166-1 alpha-2. */
export type CountryCode = Brand<string, 'CountryCode'>;
/** ujira:tx:v1:{caip2}:{txHash}:{eventIndex}. Built and read by receipt-ref.ts. */
export type ReceiptRef = Brand<string, 'ReceiptRef'>;

/** Every request carries the tenant, checked against the mandate's tenant reference on chain. */
export interface TenantScope {
  readonly principalId: Uuid;
  readonly projectId: Uuid;
}

/** A chain native address. Opaque outside the adapter; validated by parseAddress. */
export interface ChainAddress {
  readonly network: NetworkId;
  readonly value: string;
}

export interface MandateRef {
  readonly network: NetworkId;
  readonly address: ChainAddress;
  readonly specVersion: 1;
}

/** Native gas amounts, for fee accounting and cost per payout only. */
export interface NativeAmount {
  readonly network: NetworkId;
  readonly asset: 'XLM' | 'CELO';
  /** Stroops at scale 7 or wei at scale 18. */
  readonly amount: bigint;
  readonly scale: 7 | 18;
}

export type Finality = 'none' | 'included' | 'safe' | 'final';

// ---------------------------------------------------------------------------
// The adapter

export interface CallOptions {
  /** The caller's deadline. Adapters also apply their own per call timeouts. */
  readonly signal?: AbortSignal;
  /** Per payout trace ID, logged and propagated. */
  readonly correlationId: string;
}

export interface ChainAdapter {
  readonly interfaceVersion: typeof CHAIN_ADAPTER_INTERFACE_VERSION;
  readonly network: NetworkId;
  /** Data only. Callers must not branch on it; ask the adapter instead. */
  readonly chain: Chain;

  capabilities(): AdapterCapabilities;
  health(opts?: CallOptions): Promise<ChainHealth>;
  /** Throws InvalidInputError for anything that is not an address on this network. */
  parseAddress(raw: string): ChainAddress;

  readMandate(
    req: { readonly scope: TenantScope; readonly mandate: MandateRef },
    opts?: CallOptions,
  ): Promise<MandateSnapshot>;
  prepareMandateAction(req: MandateActionRequest, opts?: CallOptions): Promise<SigningRequest>;
  submitSigned(req: SignedSubmission, opts?: CallOptions): Promise<SubmissionRef>;

  fundingInstructions(req: {
    readonly scope: TenantScope;
    readonly mandate: MandateRef;
  }): Promise<FundingInstructions>;
  prepareFunding(req: PrepareFundingRequest, opts?: CallOptions): Promise<SigningRequest>;
  scanDeposits(req: DepositScanRequest, opts?: CallOptions): Promise<DepositScanPage>;

  quote(req: QuoteRequest, opts?: CallOptions): Promise<Quote>;
  pay(req: PayRequest, opts?: CallOptions): Promise<PayStep>;
  payBatch(req: PayBatchRequest, opts?: CallOptions): Promise<BatchStep>;
  status(req: StatusRequest, opts?: CallOptions): Promise<PayoutChainStatus>;
  proveDead(req: ProveDeadRequest, opts?: CallOptions): Promise<DeadProof | null>;

  receipt(req: ReceiptRequest, opts?: CallOptions): Promise<ChainReceipt>;
  verifyReceipt(ref: ReceiptRef, opts?: CallOptions): Promise<ReceiptVerification>;
}

export interface ChainAdapterRegistry {
  /** Throws UnsupportedError for a network that is disabled or has no adapter. */
  get(network: NetworkId): ChainAdapter;
  /** Enabled networks only, from the current config. */
  list(): readonly ChainAdapter[];
}

// ---------------------------------------------------------------------------
// Ports the adapter is given. Implemented outside it, faked in tests.

export interface AdapterPorts {
  /** Implemented in the db repository layer. */
  readonly store: AdapterStore;
  /** Implemented in payouts, with counters in the database. */
  readonly sponsorship: SponsorshipPolicy;
  readonly alerts: AdapterAlerts;
  readonly clock: { nowSeconds(): UnixSeconds };
  /** The current validated config snapshot. */
  readonly config: () => NetworksConfig;
}

export type SubmissionOp =
  'request' | 'request_batch' | 'execute' | 'execute_batch' | 'fund' | MandateAction['op'];

/** Live states hold the one live submission per mandate, payout and op. */
export type SubmissionState =
  'built' | 'broadcast' | 'unknown' | 'landed' | 'rejected' | 'replaced';

/** Write ahead record of a chain submission, stored before broadcast. */
export interface SubmissionRecord {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly txHash: string;
  readonly mandate: string;
  readonly payoutId: PayoutId | null;
  readonly op: SubmissionOp;
  readonly attempt: number;
  readonly signerAddress: ChainAddress;
  readonly sequenceOrNonce: bigint;
  /** Stellar envelope validity; null on Celo, where a nonce replaces it. */
  readonly maxTime: UnixSeconds | null;
  readonly landedAtHeight: bigint | null;
  readonly state: SubmissionState;
  readonly errorCode: ChainAdapterErrorCode | null;
  readonly correlationId: string;
}

export interface SubmissionPatch {
  readonly state?: SubmissionState;
  readonly landedAtHeight?: bigint | null;
  readonly errorCode?: ChainAdapterErrorCode | null;
}

/** A Stellar channel account or Celo executor account, leased to one job at a time. */
export interface ExecutorLease {
  readonly leaseId: string;
  readonly network: NetworkId;
  readonly address: ChainAddress;
  readonly sequenceOrNonce: bigint;
  readonly expiresAt: UnixSeconds;
}

/** Off chain delivery record per leg, such as an anchor transaction. No KYC fields. */
export interface LegDeliveryRecord {
  readonly scope: TenantScope;
  readonly legKey: LegKey;
  readonly rail: RailId;
  readonly provider: string;
  readonly providerRef: string;
  readonly live: boolean;
  readonly state: DeliveryState;
  readonly destination: ChainAddress | null;
  readonly tag: bigint | null;
  readonly quoteId: QuoteId | null;
  /** Scrubbed provider status, kept for support. Never branched on outside the adapter. */
  readonly rawStatus: string;
  readonly expiresAt: UnixSeconds | null;
  readonly updatedAt: UnixSeconds;
}

export interface AdapterStore {
  /** Called before broadcast. Unique on network and transaction hash. */
  recordSubmission(s: SubmissionRecord): Promise<void>;
  updateSubmission(network: NetworkId, txHash: string, patch: SubmissionPatch): Promise<void>;
  liveSubmission(key: {
    readonly network: NetworkId;
    readonly mandate: string;
    readonly payoutId: PayoutId;
    readonly op: SubmissionOp;
  }): Promise<SubmissionRecord | null>;
  unresolvedSubmissions(
    network: NetworkId,
    olderThanSeconds: number,
    limit: number,
  ): Promise<readonly SubmissionRecord[]>;
  leaseExecutor(network: NetworkId, leaseSeconds: number): Promise<ExecutorLease>;
  releaseExecutor(lease: ExecutorLease, next: { readonly sequenceOrNonce: bigint }): Promise<void>;
  /** Unique on leg key, provider and provider reference. */
  upsertDelivery(d: LegDeliveryRecord): Promise<void>;
  liveDelivery(legKey: LegKey): Promise<LegDeliveryRecord | null>;
}

export type SponsoredIntent =
  | 'fund'
  | 'create_funding_account'
  | 'create_mandate'
  | 'pause'
  | 'resume'
  | 'revoke'
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'withdraw'
  | 'admin'
  | 'trustline';

export interface SponsorshipPolicy {
  /** Throws SponsorDeniedError on a rate limit or cap. Idempotent per reservationId. */
  reserve(r: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    readonly reservationId: string;
    readonly intent: SponsoredIntent;
    readonly maxFee: NativeAmount;
  }): Promise<void>;
  settle(reservationId: string, actualFee: NativeAmount): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export interface AdapterAlerts {
  lowBalance(e: {
    readonly network: NetworkId;
    readonly account: 'fee_sponsor' | 'executor';
    readonly balance: NativeAmount;
    readonly threshold: NativeAmount;
  }): void;
  stuck(e: {
    readonly network: NetworkId;
    readonly txHash: string;
    readonly ageSeconds: number;
    readonly correlationId: string;
  }): void;
  divergence(e: {
    readonly network: NetworkId;
    readonly kind: 'balance' | 'receipt' | 'reorg';
    readonly detail: string;
    readonly correlationId: string;
  }): void;
}

// ---------------------------------------------------------------------------
// Capabilities and health

export interface RailCapability {
  readonly rail: RailId;
  readonly enabled: boolean;
  readonly deliveryCurrencies: readonly (FiatCurrencyCode | TokenAsset)[];
  readonly countries: readonly CountryCode[];
  readonly minLeg?: TokenAmount;
  readonly maxLeg?: TokenAmount;
  readonly firmQuotes: boolean;
  readonly requiresRecipientKyc: boolean;
}

export interface AdapterCapabilities {
  readonly network: NetworkId;
  readonly specVersions: readonly 1[];
  readonly settlementAssets: readonly TokenAsset[];
  readonly rails: readonly RailCapability[];
  readonly maxLegs: number;
  readonly maxBatch: number;
  readonly supportsDestinationTag: boolean;
  /** Used by the router to compare speed. */
  readonly typicalSettlementSeconds: number;
  readonly typicalFinalSeconds: number;
}

export type HealthState = 'healthy' | 'degraded' | 'down';

export interface ChainHealth {
  readonly network: NetworkId;
  readonly state: HealthState;
  readonly checkedAt: UnixSeconds;
  /** Now minus the latest closed ledger or block time. */
  readonly headLagSeconds: number;
  readonly rpcP95Ms: number;
  /** Basis points, an integer from 0 to 10000, or null with no submissions yet. */
  readonly submitSuccessRate5m: number | null;
  readonly sponsorFunded: boolean;
  readonly executorFunded: boolean;
  readonly rails: readonly {
    readonly rail: RailId;
    readonly state: HealthState;
    readonly reason?: string;
  }[];
  /** Machine codes such as HEAD_LAG, RPC_ERRORS or SPONSOR_LOW. */
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Mandate structs, mirroring the contract spec with core types

/** 1 allowlist, 2 attested, 3 both. */
export type RecipientMode = 1 | 2 | 3;

export interface LimitsInput {
  readonly totalBudget: TokenAmount;
  readonly perPaymentCap: TokenAmount;
  readonly perRecipientDailyCap: TokenAmount;
  readonly approvalThreshold: TokenAmount;
  readonly payoutTtlSeconds: bigint;
  readonly expiresAt: UnixSeconds;
}

export interface MandateConfigInput {
  readonly principal: ChainAddress;
  readonly asset: TokenAsset;
  readonly recipientMode: RecipientMode;
  readonly tenantRef: Bytes32;
  readonly agents: readonly ChainAddress[];
  readonly approvers: readonly ChainAddress[];
  readonly approvalsRequired: number;
  readonly guardians: readonly ChainAddress[];
  readonly executors: readonly ChainAddress[];
  readonly limits: LimitsInput;
  readonly recovery: readonly ChainAddress[];
  readonly recoveryThreshold: number;
  /** Uncompressed secp256k1 key, 65 bytes starting 0x04, or empty in allowlist mode. */
  readonly attester: Uint8Array;
  readonly countryPolicyHash: Bytes32;
  readonly maxFeeBps: number;
}

/** The mandate's config view: the creation input plus what the factory fixed. */
export interface MandateConfigView extends MandateConfigInput {
  readonly factory: ChainAddress;
  readonly feeAddress: ChainAddress;
  readonly policyEpoch: number;
  readonly proposedPrincipal: ChainAddress | null;
}

/** A destination is an address plus an optional tag; both must match to be equal. */
export interface AllowEntryInput {
  readonly recipientRef: Bytes32;
  readonly destination: ChainAddress;
  readonly tag?: bigint;
}

export interface AttestationInput {
  readonly legIndex: number;
  readonly validUntil: UnixSeconds;
  /** r, s and v: 65 bytes, low s, v of 27 or 28. */
  readonly signature: Uint8Array;
}

// ---------------------------------------------------------------------------
// Mandate administration and signing

export type MandateRole = 'agent' | 'approver' | 'guardian' | 'executor';

export type MandateAction =
  | {
      readonly op: 'create';
      readonly factory: ChainAddress;
      readonly config: MandateConfigInput;
      readonly salt: Bytes32;
    }
  | { readonly op: 'pause' }
  | { readonly op: 'resume' }
  | { readonly op: 'revoke' }
  | { readonly op: 'approve'; readonly payoutId: PayoutId }
  | { readonly op: 'reject'; readonly payoutId: PayoutId }
  | { readonly op: 'cancel'; readonly payoutId: PayoutId }
  | { readonly op: 'cancel_batch'; readonly payoutIds: readonly PayoutId[] }
  | { readonly op: 'withdraw'; readonly amount: TokenAmount }
  | { readonly op: 'sweep' }
  | { readonly op: 'recover_token'; readonly token: ChainAddress; readonly amount: bigint }
  | { readonly op: 'update_limits'; readonly limits: LimitsInput }
  | {
      readonly op: 'add_role' | 'remove_role';
      readonly role: MandateRole;
      readonly account: ChainAddress;
    }
  | { readonly op: 'set_approvals_required'; readonly n: number }
  | {
      readonly op: 'allow_recipients' | 'disallow_recipients';
      readonly entries: readonly AllowEntryInput[];
    }
  | {
      readonly op: 'set_attestation_policy';
      readonly attester: Uint8Array;
      readonly countryPolicyHash: Bytes32;
    }
  | { readonly op: 'propose_principal'; readonly proposed: ChainAddress }
  | { readonly op: 'accept_principal' };

export interface MandateActionRequest {
  readonly scope: TenantScope;
  /** Null only for op 'create'. */
  readonly mandate: MandateRef | null;
  readonly action: MandateAction;
}

/** Human readable and chain neutral, shown before signing. Amounts are core values. */
export interface SigningSummary {
  readonly action: MandateAction['op'] | 'fund' | 'request_payout' | 'request_payouts';
  readonly mandate?: MandateRef;
  readonly amount?: TokenAmount;
  readonly feePaidBy: 'ujira' | 'signer';
  readonly estimatedFee?: TokenAmount | NativeAmount;
}

/** What a wallet must sign. Built by the adapter, which keeps its own copy to compare. */
export type SigningRequest =
  | {
      readonly kind: 'stellar_transaction';
      readonly network: NetworkId;
      readonly xdr: string;
      readonly signer: ChainAddress;
      readonly validUntil: UnixSeconds;
      readonly sponsored: boolean;
      readonly summary: SigningSummary;
      readonly requestId: string;
    }
  | {
      readonly kind: 'stellar_auth_entry';
      readonly network: NetworkId;
      readonly entryXdr: string;
      readonly signer: ChainAddress;
      readonly expirationLedger: number;
      readonly summary: SigningSummary;
      readonly requestId: string;
    }
  | {
      readonly kind: 'evm_transaction';
      readonly network: NetworkId;
      readonly chainId: number;
      readonly tx: {
        readonly to: string;
        readonly data: string;
        readonly value: 0n;
        readonly gas: bigint;
        readonly maxFeePerGas: bigint;
        readonly maxPriorityFeePerGas: bigint;
        readonly feeCurrency: string | null;
      };
      readonly signer: ChainAddress;
      readonly validUntil: UnixSeconds;
      readonly summary: SigningSummary;
      readonly requestId: string;
    };

export interface SignedSubmission {
  readonly scope: TenantScope;
  /** The adapter reloads the exact request it built and refuses a different payload. */
  readonly requestId: string;
  /** Signed XDR, signed auth entry XDR, or raw EVM transaction hex. */
  readonly signed: string;
  readonly correlationId: string;
}

export interface SubmissionRef {
  readonly network: NetworkId;
  readonly txHash: string;
  /** 'none' when broadcast but not seen yet. */
  readonly finality: Finality;
}

// ---------------------------------------------------------------------------
// Mandate snapshot

export interface MandateState {
  readonly spent: TokenAmount;
  readonly pending: TokenAmount;
  readonly committed: TokenAmount;
  readonly balance: TokenAmount;
  readonly free: TokenAmount;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly expired: boolean;
  readonly policyEpoch: number;
}

export interface MandateSnapshot {
  readonly mandate: MandateRef;
  /** Created by a factory the config trusts for this spec version. */
  readonly trustedFactory: boolean;
  /** The on chain tenant reference matches the request scope. */
  readonly tenantRefMatches: boolean;
  readonly asset: TokenAsset;
  readonly config: MandateConfigView;
  readonly state: MandateState;
  readonly observedAt: {
    readonly ledgerOrBlock: bigint;
    readonly time: UnixSeconds;
    readonly finality: Finality;
  };
}

// ---------------------------------------------------------------------------
// Funding and deposits

export interface FundingInstructions {
  readonly mandate: MandateRef;
  /** The mandate address is the funding address. */
  readonly address: ChainAddress;
  readonly asset: TokenAsset;
  /** Token contract, shown so the principal can verify it. */
  readonly assetContract: string;
  readonly label: string;
  readonly memoRequired: false;
  readonly warnings: readonly (
    'other_assets_not_credited' | 'wrong_network_lost' | 'exchange_contract_address_support'
  )[];
  /** When a deposit counts as available. */
  readonly availableAt: Finality;
}

export interface PrepareFundingRequest {
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  readonly from: ChainAddress;
  readonly amount: TokenAmount;
}

export interface WatchedMandate {
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  readonly asset: TokenAsset;
}

export interface DepositScanRequest {
  /** Opaque and adapter specific; null starts at the configured start height. */
  readonly cursor: string | null;
  /** Events, not blocks; at most 1000. */
  readonly limit: number;
  /** Database lookup that attaches the tenant. */
  readonly isWatched: (address: ChainAddress) => Promise<WatchedMandate | null>;
}

export interface Deposit {
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  readonly txHash: string;
  readonly eventIndex: number;
  /** Null when the source is not an address. */
  readonly from: ChainAddress | null;
  readonly asset: TokenAsset | 'other';
  readonly tokenContract: string;
  /** Unknown assets keep their raw units and scale. */
  readonly amount: TokenAmount | { readonly amount: bigint; readonly scale: number };
  readonly ledgerOrBlock: bigint;
  /** Kept where reorgs are possible; null where inclusion is final. */
  readonly blockHash: string | null;
  readonly closedAt: UnixSeconds;
  readonly finality: Finality;
}

export interface DepositScanPage {
  readonly deposits: readonly Deposit[];
  readonly nextCursor: string;
  readonly head: { readonly ledgerOrBlock: bigint; readonly safe: bigint; readonly final: bigint };
  /** Deposits reported earlier that are gone now. */
  readonly reorged: readonly { readonly txHash: string; readonly eventIndex: number }[];
}

// ---------------------------------------------------------------------------
// Quotes

export interface QuoteRequest {
  readonly scope: TenantScope;
  readonly rail: RailId;
  readonly country: CountryCode;
  readonly sell: { readonly asset: TokenAsset };
  readonly buy: { readonly currency: FiatCurrencyCode | TokenAsset };
  readonly amount:
    | { readonly side: 'sell'; readonly value: TokenAmount }
    | { readonly side: 'buy'; readonly value: Money };
  /** Firm only where the rail supports it. */
  readonly firm: boolean;
  readonly recipientMethodId?: Uuid;
}

export interface QuoteFee {
  readonly kind: 'anchor' | 'swap' | 'network' | 'offramp';
  readonly amount: TokenAmount | Money;
  readonly paidBy: 'recipient' | 'principal' | 'ujira';
}

export interface Quote {
  readonly id: QuoteId;
  readonly network: NetworkId;
  readonly rail: RailId;
  /** par: same asset, no conversion. */
  readonly source: 'sep38' | 'mento' | 'par';
  readonly firm: boolean;
  /** What leaves the mandate. */
  readonly sell: TokenAmount;
  /** What the recipient receives. */
  readonly buy: Money;
  readonly fees: readonly QuoteFee[];
  /** Buy per sell in minor units, for display only. */
  readonly price: { readonly numerator: bigint; readonly denominator: bigint };
  /** Slippage floor where the price is not firm. */
  readonly minBuy?: Money;
  readonly expiresAt: UnixSeconds;
  readonly providerRef?: string;
}

// ---------------------------------------------------------------------------
// Payouts

export interface PayoutLegInput {
  /** 0 to maxLegs - 1. Leg 0 carries the rounding remainder. */
  readonly index: number;
  readonly legKey: LegKey;
  readonly rail: RailId;
  readonly recipientMethodId: Uuid;
  /** In the mandate asset. */
  readonly amount: TokenAmount;
  readonly deliveryCurrency: FiatCurrencyCode | TokenAsset;
  readonly quoteId?: QuoteId;
}

export interface PayRequest {
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  readonly payoutId: PayoutId;
  readonly attempt: number;
  readonly recipientRef: Bytes32;
  readonly taskRef: Bytes32;
  readonly total: TokenAmount;
  /** Must sum exactly to total. */
  readonly legs: readonly PayoutLegInput[];
  /** After this the request can be proven dead and retried elsewhere. */
  readonly deadline: UnixSeconds;
  /** One per leg; empty in allowlist mode. */
  readonly attestations: readonly AttestationInput[];
  /** hold: approved but not executed yet, for anchor or schedule timing. */
  readonly execute: 'auto' | 'hold';
}

export interface ApprovalCount {
  readonly count: number;
  readonly required: number;
}

export type PayStep =
  | { readonly kind: 'signature_required'; readonly request: SigningRequest }
  | {
      readonly kind: 'submitted';
      readonly op: 'request' | 'execute';
      readonly submission: SubmissionRef;
    }
  | { readonly kind: 'awaiting_approval'; readonly approvals: ApprovalCount }
  | { readonly kind: 'held' }
  /** Landed, with finality possibly below final. */
  | { readonly kind: 'settled'; readonly receipt: ChainReceipt }
  | { readonly kind: 'final'; readonly receipt: ChainReceipt }
  /** Rejected, cancelled or lapsed. */
  | { readonly kind: 'dead'; readonly proof: DeadProof };

export interface PayBatchRequest {
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  /** All on this mandate; at most capabilities().maxBatch. */
  readonly items: readonly PayRequest[];
}

export interface BatchStep {
  readonly items: readonly {
    readonly payoutId: PayoutId;
    readonly step:
      PayStep | { readonly kind: 'item_failed'; readonly error: ChainAdapterErrorJson };
  }[];
  readonly submissions: readonly SubmissionRef[];
}

export interface StatusRequest {
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  readonly payoutId: PayoutId;
  readonly legs: readonly LegKey[];
}

export type OnChainPayoutState =
  'absent' | 'pending' | 'approved' | 'executed' | 'rejected' | 'cancelled';

export type DeliveryState =
  /** Wallet rails, where settlement is delivery. */
  | 'not_applicable'
  | 'awaiting_settlement'
  | 'in_transit'
  /** The recipient or sender must act, such as a KYC update or a cash pickup. */
  | 'action_required'
  | 'delivered'
  | 'failed'
  /** The rail returned the funds to the mandate. */
  | 'refunded'
  | 'expired';

export interface LegDeliveryStatus {
  readonly legKey: LegKey;
  readonly rail: RailId;
  readonly state: DeliveryState;
  readonly provider?: {
    readonly id: string;
    readonly ref: string;
    /** Kept for support. Never branched on outside the adapter. */
    readonly rawStatus: string;
  };
  readonly updatedAt: UnixSeconds;
}

export interface PayoutChainStatus {
  readonly payoutId: PayoutId;
  readonly network: NetworkId;
  readonly onChain: OnChainPayoutState;
  readonly finality: Finality;
  /** Past the payout's expiry while still pending or approved. */
  readonly lapsed: boolean;
  readonly approvals?: ApprovalCount;
  readonly legs: readonly LegDeliveryStatus[];
  readonly receipt?: ReceiptRef;
  readonly observedAt: { readonly ledgerOrBlock: bigint; readonly time: UnixSeconds };
}

export interface ProveDeadRequest {
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  readonly payoutId: PayoutId;
  readonly deadline: UnixSeconds;
}

/** Proof, at final, that an attempt can never land, so the next one may go elsewhere. */
export type DeadProof =
  | {
      readonly kind: 'tombstone';
      readonly network: NetworkId;
      readonly status: 'rejected' | 'cancelled';
      readonly at: { readonly ledgerOrBlock: bigint; readonly finality: 'final' };
    }
  | {
      readonly kind: 'deadline_passed';
      readonly network: NetworkId;
      readonly finalTime: UnixSeconds;
      readonly at: { readonly ledgerOrBlock: bigint; readonly finality: 'final' };
    };

// ---------------------------------------------------------------------------
// Receipts

export interface ReceiptLeg {
  readonly index: number;
  readonly destination: ChainAddress;
  readonly tag?: bigint;
  readonly amount: TokenAmount;
}

export interface ChainReceipt {
  readonly ref: ReceiptRef;
  readonly network: NetworkId;
  readonly txHash: string;
  /** Index of the payout event within the transaction, for batches. */
  readonly eventIndex: number;
  readonly ledgerOrBlock: bigint;
  readonly blockHash: string | null;
  readonly closedAt: UnixSeconds;
  readonly finality: 'included' | 'safe' | 'final';
  readonly mandate: MandateRef;
  readonly payoutId: PayoutId;
  readonly total: TokenAmount;
  readonly legs: readonly ReceiptLeg[];
  /** Paid by the executor; UJIRA's cost. */
  readonly networkFee: NativeAmount;
  /** Built from the config template when read, so the stored reference never changes. */
  readonly explorerUrl: string;
}

export interface ReceiptRequest {
  readonly scope: TenantScope;
  readonly mandate: MandateRef;
  readonly payoutId: PayoutId;
}

export type ReceiptVerification =
  | { readonly ok: true; readonly receipt: ChainReceipt }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'reorged' | 'mismatch' | 'outside_rpc_retention';
    };
