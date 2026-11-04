// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The chain agnostic interface every network adapter implements. Nothing
// here names an SDK type: callers outside this package see plain strings,
// bigints and core money values only, so a router or payout job can never
// grow a dependency on one chain.
//
// Signing is a separate port with its own types (signer references,
// payloads and results) in signer.ts. The adapter is given the port, and
// requests name who signs with a SignerRef.

import type { Chain, FiatCurrencyCode, Money, TokenAmount, TokenAsset } from '@ujira/core';

import type { ChainAdapterErrorCode, ChainAdapterErrorJson } from './errors.js';
import type { NetworkId } from './networks.js';
import type { NetworksConfig } from './config.js';
import type { AttestationFields, SignerProvider, SignerRef } from './signer.js';

export const CHAIN_ADAPTER_INTERFACE_VERSION = 1 as const;

/** USDC to the recipient's own wallet, or local currency through a SEP-31 anchor. */
export type RailId = 'stellar.wallet' | 'stellar.sep31';

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

/** Every request carries the tenant, checked against the mandate's tenant tag on chain. */
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

/** Native fee amounts, for fee accounting and cost per payout only. */
export interface NativeAmount {
  readonly network: NetworkId;
  readonly asset: 'XLM';
  /** Stroops, at scale 7. */
  readonly amount: bigint;
  readonly scale: 7;
}

export type Finality = 'none' | 'included' | 'safe' | 'final';

// ---------------------------------------------------------------------------
// The adapter

/** Required on every call that can reach a network, so the trace ID always travels. */
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
  health(opts: CallOptions): Promise<ChainHealth>;
  /** Throws InvalidInputError for anything that is not an address on this network. */
  parseAddress(raw: string): ChainAddress;
  /**
   * Reads a recipient's destination into the address and tag pair the
   * mandate binds and the database stores. Nothing outside the adapter reads
   * addresses, so nothing outside it learns a chain's address forms. Throws
   * InvalidInputError carrying a DestinationParseReason.
   */
  parseDestination(raw: RawDestination): Destination;
  /**
   * The 47 byte message the attester signs for one leg, built byte for byte
   * as this chain's mandate rebuilds it before it verifies the signature.
   * Pure: no network call and no key. Only the adapter knows the chain's
   * address encoding, so nothing else builds these bytes. Throws
   * InvalidInputError for fields the mandate could never accept.
   */
  attestationMessage(fields: AttestationFields): Uint8Array;

  readMandate(
    req: { readonly scope: TenantScope; readonly mandate: MandateRef },
    opts: CallOptions,
  ): Promise<MandateSnapshot>;
  prepareMandateAction(req: MandateActionRequest, opts: CallOptions): Promise<SigningRequest>;
  submitSigned(req: SignedSubmission, opts: CallOptions): Promise<SubmissionRef>;

  fundingInstructions(
    req: { readonly scope: TenantScope; readonly mandate: MandateRef },
    opts: CallOptions,
  ): Promise<FundingInstructions>;
  prepareFunding(req: PrepareFundingRequest, opts: CallOptions): Promise<SigningRequest>;
  scanDeposits(req: DepositScanRequest, opts: CallOptions): Promise<DepositScanPage>;

  quote(req: QuoteRequest, opts: CallOptions): Promise<Quote>;
  pay(req: PayRequest, opts: CallOptions): Promise<PayStep>;
  payBatch(req: PayBatchRequest, opts: CallOptions): Promise<BatchStep>;
  status(req: StatusRequest, opts: CallOptions): Promise<PayoutChainStatus>;
  proveDead(req: ProveDeadRequest, opts: CallOptions): Promise<DeadProof | null>;

  receipt(req: ReceiptRequest, opts: CallOptions): Promise<ChainReceipt>;
  verifyReceipt(ref: ReceiptRef, opts: CallOptions): Promise<ReceiptVerification>;
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
  /** Every key UJIRA holds signs through it; the adapter never sees key material. */
  readonly signer: SignerProvider;
  /** createSponsorshipPolicy over the database ledger, or a stand in under test. */
  readonly sponsorship: SponsorshipPolicy;
  readonly alerts: AdapterAlerts;
  readonly clock: { nowSeconds(): UnixSeconds };
  /** The current validated config snapshot. */
  readonly config: () => NetworksConfig;
}

/** Every operation the adapter submits: mandate calls and the adapter's own steps. */
export type SubmissionOp =
  | 'create'
  | 'request'
  | 'request_batch'
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'cancel_batch'
  | 'execute'
  | 'execute_batch'
  | 'pause'
  | 'resume'
  | 'revoke'
  | 'withdraw'
  | 'sweep'
  | 'recover_token'
  | 'update_limits'
  | 'add_role'
  | 'remove_role'
  | 'set_approvals_required'
  | 'set_recovery_threshold'
  | 'allow_recipients'
  | 'disallow_recipients'
  | 'set_attestation_policy'
  | 'propose_principal'
  | 'accept_principal'
  | 'cancel_principal_proposal'
  | 'lower_fee_cap'
  | 'recovery_revoke'
  | 'recovery_rotate_agent'
  | 'fund'
  | 'create_funding_account'
  | 'funding_sweep'
  | 'trustline'
  | 'ttl_extend'
  | 'restore';

/**
 * Lifecycle of one write ahead submission. built, broadcast and unknown are
 * live, and at most one submission per network, mandate, payout and op may
 * be live. States only move forward: built to broadcast, broadcast to any
 * of landed, failed, unknown, expired or replaced, and unknown to landed,
 * failed or expired.
 */
export type SubmissionState =
  /** Recorded before broadcast, with the signature. */
  | 'built'
  /** Sent, with no result yet. */
  | 'broadcast'
  /** A timeout or an ambiguous status. Reconcile before any retry. */
  | 'unknown'
  /** Included with success. Finality is tracked separately. */
  | 'landed'
  /** Included and failed, or definitely rejected. */
  | 'failed'
  /** Can provably never land: its validity window passed and was observed. */
  | 'expired'
  /** Superseded by a fee bump or resubmission of the same envelope. */
  | 'replaced';

/** Write ahead record of a chain submission, stored before broadcast. */
export interface SubmissionRecord {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly txHash: string;
  readonly op: SubmissionOp;
  /**
   * The mandate contract address as the chain writes it, a C strkey on
   * Stellar. Null for steps that touch no mandate, such as a funding
   * account.
   */
  readonly mandate: string | null;
  readonly payoutId: PayoutId | null;
  readonly attempt: number | null;
  /** The signing account, in the same chain encoding as `mandate`. */
  readonly signerAddress: string;
  readonly sequenceOrNonce: bigint;
  /** The envelope's validity limit, or null when it has none. */
  readonly maxTime: UnixSeconds | null;
  readonly state: SubmissionState;
  readonly landedAtHeight: bigint | null;
  readonly errorCode: ChainAdapterErrorCode | null;
  /** The mandate contract's error code when the mandate refused the call. */
  readonly specCode: number | null;
  /** The submission this one replaced, for a fee bump of the same envelope. */
  readonly replacesTxHash: string | null;
  /**
   * The latest ledger just before the send, or null where none was read. A
   * transaction cannot land before it, so an RPC whose retention reaches back
   * this far can prove the transaction is gone.
   */
  readonly submittedAtLedger: bigint | null;
  /** The sponsorship reservation paying for it, or null for UJIRA's own transaction. */
  readonly reservationId: string | null;
  readonly correlationId: string;
  readonly createdAt: UnixSeconds;
}

export type SubmissionPatch = Partial<
  Pick<SubmissionRecord, 'state' | 'landedAtHeight' | 'errorCode' | 'specCode'>
>;

/** A Stellar channel account, leased to one job at a time. */
export interface ExecutorLease {
  readonly network: NetworkId;
  readonly address: ChainAddress;
  /** The key manager's ID for the account's key. */
  readonly keyId: string;
  /** The next sequence number to use, read from chain when the previous lease expired. */
  readonly sequenceOrNonce: bigint;
  /**
   * Fencing token, new on every lease. releaseExecutor refuses a stale one,
   * so a job that outlived its lease cannot write a sequence back over the
   * job that holds the account now.
   */
  readonly leaseId: string;
  readonly expiresAt: UnixSeconds;
}

/**
 * An address plus an optional tag. Two destinations are equal only if both
 * match. The address is a base account or a contract, never a muxed form:
 * parseDestination reads an M address into its account and its id.
 */
export interface Destination {
  readonly address: ChainAddress;
  readonly tag: bigint | null;
}

/** A destination as a recipient or a provider gives it, before parsing. */
export interface RawDestination {
  readonly address: string;
  /**
   * A numeric memo id in decimal, for an address that needs one, such as an
   * exchange's pooled account. Text and hash memos are refused.
   */
  readonly memoId?: string | undefined;
}

/** Off chain delivery record per leg, such as an anchor transaction. No KYC fields. */
export interface LegDeliveryRecord {
  readonly scope: TenantScope;
  readonly legKey: LegKey;
  readonly network: NetworkId;
  readonly rail: RailId;
  /** Anchor or partner ID, or 'wallet'. */
  readonly provider: string;
  /** Anchor transaction ID or order ID. */
  readonly providerRef: string | null;
  readonly destination: Destination;
  readonly quoteId: QuoteId | null;
  readonly state: DeliveryState;
  /** Scrubbed provider status, kept for support. Never branched on outside the adapter. */
  readonly rawStatus: string | null;
  /** At most one live record per leg key and provider. */
  readonly live: boolean;
  readonly expiresAt: UnixSeconds | null;
  readonly updatedAt: UnixSeconds;
}

/**
 * The adapter's only storage. Every call that reads or writes a tenant's
 * row takes the tenant, so an implementation can run inside the tenant's
 * own transaction and never look a tenant up from the row it is reading.
 */
export interface AdapterStore {
  /** Called before broadcast. Unique on network and transaction hash. */
  recordSubmission(s: SubmissionRecord): Promise<void>;
  /**
   * Network and hash are unique across every tenant, so the implementation
   * must also match the scope, or one tenant could patch another's row by
   * hash.
   */
  updateSubmission(
    scope: TenantScope,
    network: NetworkId,
    txHash: string,
    patch: SubmissionPatch,
  ): Promise<void>;
  liveSubmission(key: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    /** Chain encoded, as in SubmissionRecord. */
    readonly mandate: string;
    readonly payoutId: PayoutId;
    readonly op: SubmissionOp;
  }): Promise<SubmissionRecord | null>;
  /**
   * Platform operation: the reconciliation sweep reads unresolved
   * submissions across every tenant on purpose, and each record it returns
   * carries its own scope for the follow up calls.
   */
  unresolvedSubmissions(
    network: NetworkId,
    olderThanSeconds: number,
    limit: number,
  ): Promise<readonly SubmissionRecord[]>;
  /** Platform operation: executor accounts are UJIRA's own and belong to no tenant. */
  leaseExecutor(network: NetworkId, leaseSeconds: number): Promise<ExecutorLease>;
  /** Platform operation. Refuses a lease whose leaseId is no longer current. */
  releaseExecutor(lease: ExecutorLease, next: { readonly sequenceOrNonce: bigint }): Promise<void>;
  /**
   * Unique on leg key, provider and provider reference. Leg keys derive
   * from the payout ID, which hashes the tenant in, and the implementation
   * still matches the record's scope on every write.
   */
  upsertDelivery(d: LegDeliveryRecord): Promise<void>;
  liveDelivery(scope: TenantScope, legKey: LegKey): Promise<LegDeliveryRecord | null>;
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
  | 'trustline'
  | 'recipient_activation'
  /** UJIRA's own transaction, booked for the record and never reserved by a tenant. */
  | 'executor';

export interface SponsorshipPolicy {
  /** Throws SponsorDeniedError on a rate limit or cap. Idempotent per reservationId. */
  reserve(r: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    readonly reservationId: string;
    readonly intent: SponsoredIntent;
    readonly maxFee: NativeAmount;
    /** For recipient_activation: who is activated. One per recipient per network, one per account ever. */
    readonly activation?: { readonly recipientId: string; readonly account: string };
  }): Promise<void>;
  /** The counters are per principal rows, so the tenant comes with every call. */
  settle(r: {
    readonly scope: TenantScope;
    readonly reservationId: string;
    readonly actualFee: NativeAmount;
    /** The rent the transaction paid, booked with it. */
    readonly rent?: NativeAmount;
  }): Promise<void>;
  release(r: { readonly scope: TenantScope; readonly reservationId: string }): Promise<void>;
  /**
   * Records what UJIRA paid for a transaction of its own, such as an executor
   * call, so all its spend sums from one place. Idempotent per reservationId.
   */
  book(r: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    readonly reservationId: string;
    readonly intent: SponsoredIntent;
    readonly actualFee: NativeAmount;
    readonly rent?: NativeAmount;
  }): Promise<void>;
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
  /**
   * An execute batch hit the contract events limit, which batches within
   * the spec limits never should, or held a payout whose agent was removed,
   * which the payout's principal is told about.
   */
  batch(e: {
    readonly network: NetworkId;
    readonly kind: 'events_limit' | 'agent_removed';
    readonly scope: TenantScope;
    /** The removed agent's payout; null for the events limit. */
    readonly payoutId: PayoutId | null;
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
  /** False while the signer is down; the network is then degraded at best. */
  readonly signerHealthy: boolean;
  readonly rails: readonly {
    readonly rail: RailId;
    readonly state: HealthState;
    readonly reason?: string;
  }[];
  /** Machine codes such as HEAD_LAG, RPC_ERRORS, SPONSOR_LOW or SIGNER_DOWN. */
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Mandate structs, mirroring the mandate contract's types with core types

export interface LimitsInput {
  readonly totalBudget: TokenAmount;
  readonly perPaymentCap: TokenAmount;
  readonly perRecipientDailyCap: TokenAmount;
  /** May be zero, meaning every payout needs approval. */
  readonly approvalThreshold: TokenAmount;
  readonly payoutTtlSeconds: number;
  readonly expiresAt: UnixSeconds;
}

export interface MandateConfigInput {
  readonly principal: ChainAddress;
  /** Resolved to the network's token contract by the adapter. */
  readonly asset: TokenAsset;
  readonly recipientMode: 'allowlist' | 'attested' | 'both';
  readonly agents: readonly ChainAddress[];
  readonly approvers: readonly ChainAddress[];
  readonly approvalsRequired: number;
  readonly guardians: readonly ChainAddress[];
  readonly executors: readonly ChainAddress[];
  readonly recovery: readonly ChainAddress[];
  readonly recoveryThreshold: number;
  readonly limits: LimitsInput;
  /** The attester's 32 byte ed25519 public key; null in allowlist mode. */
  readonly attester: Uint8Array | null;
  readonly countryPolicyHash: Bytes32;
  /** The fee cap in basis points. The fee address comes from the factory. */
  readonly maxFeeBps: number;
}

/** The mandate's config view: the creation input plus what the factory fixed. */
export interface MandateConfigView extends MandateConfigInput {
  /**
   * The tag the mandate stores: its tenant's reference hashed with its own
   * address. The adapter computes it from the request's scope, so the
   * reference itself never reaches the chain and is not part of the config.
   */
  readonly tenantTag: Bytes32;
  readonly factory: ChainAddress;
  readonly feeAddress: ChainAddress;
  readonly policyEpoch: number;
  readonly proposedPrincipal: ChainAddress | null;
}

export interface AllowEntryInput {
  readonly recipientRef: Bytes32;
  readonly destination: Destination;
}

export interface AttestationInput {
  readonly legIndex: number;
  readonly validUntil: UnixSeconds;
  /** The attester's 64 byte ed25519 signature over the attestation message. */
  readonly signature: Uint8Array;
}

// ---------------------------------------------------------------------------
// Mandate administration and signing

export type RoleName = 'agent' | 'approver' | 'guardian' | 'executor' | 'recovery';

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
      readonly role: RoleName;
      readonly account: ChainAddress;
    }
  | { readonly op: 'set_approvals_required'; readonly n: number }
  | { readonly op: 'set_recovery_threshold'; readonly n: number }
  /** Lower only, to any value below the current cap. */
  | { readonly op: 'lower_fee_cap'; readonly maxFeeBps: number }
  | { readonly op: 'cancel_principal_proposal' }
  /** Signed by a recovery member. */
  | { readonly op: 'recovery_revoke' }
  /** Signed by a recovery member. A null `new` removes the agent. */
  | {
      readonly op: 'recovery_rotate_agent';
      readonly old: ChainAddress;
      readonly new: ChainAddress | null;
    }
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
  /**
   * Who authorizes the action: a member's own wallet, which gets a
   * SigningRequest back, or a key UJIRA holds, which the adapter signs with
   * through the port.
   */
  readonly signer: SignerRef;
  /**
   * The address the call names as its caller, where it takes one. It must be
   * the signer's own address: the adapter refuses any other before it
   * simulates, so an action can never be built for one member and signed by
   * another. Defaults to the signer's address.
   */
  readonly caller?: ChainAddress;
}

/** Human readable and chain neutral, shown before signing. Amounts are core values. */
export interface SigningSummary {
  readonly action: MandateAction['op'] | 'fund' | 'request_payout' | 'request_payouts';
  /** The mandate acted on. For a create, the one it will deploy, so its row can exist first. */
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
    };

export interface SignedSubmission {
  readonly scope: TenantScope;
  /** The adapter reloads the exact request it built and refuses a different payload. */
  readonly requestId: string;
  /** Signed transaction XDR or signed auth entry XDR. */
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
  /** Created by a factory the config trusts for this mandate version. */
  readonly trustedFactory: boolean;
  /** The tag the mandate stores is the one recomputed from the request scope and its address. */
  readonly tenantTagMatches: boolean;
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
  readonly source: 'sep38' | 'par';
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
  /**
   * The take rate on top of total, in the same asset; zero when there is
   * none. The recipient receives exactly total.
   */
  readonly fee: TokenAmount;
  /** Must sum exactly to total. */
  readonly legs: readonly PayoutLegInput[];
  /** After this the request can be proven dead and retried elsewhere. */
  readonly deadline: UnixSeconds;
  /** One per leg; empty in allowlist mode. */
  readonly attestations: readonly AttestationInput[];
  /** hold: approved but not executed yet, for anchor or schedule timing. */
  readonly execute: 'auto' | 'hold';
  /**
   * The agent that requests the payout: a managed agent key, or the agent's
   * own wallet, which gets a signature_required step back. The executor
   * that executes it comes from a lease, not from here.
   */
  readonly signer: SignerRef;
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
