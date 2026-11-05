// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compile time checks on the public types, run by typecheck. No chain SDK
// is a dependency of this package, so an SDK type in a signature would fail
// to resolve and collapse to any; every exported shape is pinned to plain
// strings, bigints and core money types instead, and checked not to be any.

import type { Chain, FiatCurrencyCode, Money, TokenAmount, TokenAsset } from '@ujira/core';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  ChainNamespace,
  RailId,
  AdapterCapabilities,
  AdapterPorts,
  AdapterStore,
  CallOptions,
  ExecutorLease,
  LegDeliveryRecord,
  MandateConfigInput,
  RoleName,
  SubmissionOp,
  SubmissionState,
  SponsorshipPolicy,
  LimitsInput,
  AllowEntryInput,
  AttestationFields,
  AttestationInput,
  SubmissionPatch,
  UnixSeconds,
  Bytes32,
  BatchStep,
  ChainAdapter,
  ChainAdapterErrorJson,
  ChainAddress,
  ChainHealth,
  ChainReceipt,
  DeadProof,
  Deposit,
  Destination,
  DestinationParseReason,
  InvalidInputError,
  RawDestination,
  DepositScanPage,
  FundingInstructions,
  MandateAction,
  MandateRef,
  MandateSnapshot,
  NativeAmount,
  NetworkId,
  NetworksConfig,
  PayRequest,
  PayStep,
  PayoutChainStatus,
  Quote,
  ReceiptRef,
  ReceiptVerification,
  SigningRequest,
  SubmissionRecord,
  TenantScope,
  Uuid,
} from './index.js';

// The top level shapes callers hold. None may be any.
interface ExportedTypes {
  adapter: ChainAdapter;
  ports: AdapterPorts;
  store: AdapterStore;
  capabilities: AdapterCapabilities;
  health: ChainHealth;
  action: MandateAction;
  signing: SigningRequest;
  snapshot: MandateSnapshot;
  funding: FundingInstructions;
  deposit: Deposit;
  page: DepositScanPage;
  quote: Quote;
  pay: PayRequest;
  step: PayStep;
  batch: BatchStep;
  status: PayoutChainStatus;
  dead: DeadProof;
  receipt: ChainReceipt;
  verification: ReceiptVerification;
  errorJson: ChainAdapterErrorJson;
  submission: SubmissionRecord;
  config: NetworksConfig;
}

expectTypeOf<ExportedTypes>().not.toBeAny();
expectTypeOf<
  { [K in keyof ExportedTypes]: 0 extends 1 & ExportedTypes[K] ? K : never }[keyof ExportedTypes]
>().toBeNever();

describe('closed unions', () => {
  it("Chain is 'stellar' and TokenAsset is 'USDC'", () => {
    expectTypeOf<Chain>().toEqualTypeOf<'stellar'>();
    expectTypeOf<TokenAsset>().toEqualTypeOf<'USDC'>();
  });

  it('NetworkId, RailId, native asset, signing payload and quote source have only Stellar members', () => {
    expectTypeOf<NetworkId>().toEqualTypeOf<'stellar:pubnet' | 'stellar:testnet'>();
    expectTypeOf<RailId>().toEqualTypeOf<'stellar.wallet' | 'stellar.sep31'>();
    expectTypeOf<NativeAmount['asset']>().toEqualTypeOf<'XLM'>();
    expectTypeOf<NativeAmount['scale']>().toEqualTypeOf<7>();
    expectTypeOf<SigningRequest['kind']>().toEqualTypeOf<
      'stellar_transaction' | 'stellar_auth_entry'
    >();
    expectTypeOf<Quote['source']>().toEqualTypeOf<'sep38' | 'par'>();
    expectTypeOf<ChainNamespace>().toEqualTypeOf<'stellar'>();
  });
});

expectTypeOf<ChainAdapter['network']>().toEqualTypeOf<NetworkId>();
expectTypeOf<ChainAdapter['chain']>().toEqualTypeOf<Chain>();
expectTypeOf<ChainAdapter['interfaceVersion']>().toEqualTypeOf<1>();
expectTypeOf<ChainAddress['value']>().toEqualTypeOf<string>();
expectTypeOf<MandateRef['specVersion']>().toEqualTypeOf<1>();

// Branded identifiers are strings underneath and not interchangeable.
expectTypeOf<Uuid>().toExtend<string>();
expectTypeOf<string>().not.toExtend<Uuid>();
expectTypeOf<ReceiptRef>().toExtend<string>();
expectTypeOf<Uuid>().not.toExtend<ReceiptRef>();
expectTypeOf<TenantScope>().toEqualTypeOf<{
  readonly principalId: Uuid;
  readonly projectId: Uuid;
}>();

// Amounts are core money values or bigint, never number.
expectTypeOf<PayRequest['total']>().toEqualTypeOf<TokenAmount>();
expectTypeOf<Quote['sell']>().toEqualTypeOf<TokenAmount>();
expectTypeOf<Quote['buy']>().toEqualTypeOf<Money>();
expectTypeOf<ChainReceipt['total']>().toEqualTypeOf<TokenAmount>();
expectTypeOf<NativeAmount['amount']>().toEqualTypeOf<bigint>();
expectTypeOf<MandateSnapshot['state']['free']>().toEqualTypeOf<TokenAmount>();
expectTypeOf<FundingInstructions['asset']>().toEqualTypeOf<TokenAsset>();
expectTypeOf<AdapterCapabilities['rails'][number]['deliveryCurrencies'][number]>().toEqualTypeOf<
  FiatCurrencyCode | TokenAsset
>();
expectTypeOf<Extract<MandateAction, { op: 'withdraw' }>['amount']>().toEqualTypeOf<TokenAmount>();

// Signing requests hand wallets plain encodings, not SDK objects.
expectTypeOf<
  Extract<SigningRequest, { kind: 'stellar_transaction' }>['xdr']
>().toEqualTypeOf<string>();
expectTypeOf<
  Extract<SigningRequest, { kind: 'stellar_auth_entry' }>['entryXdr']
>().toEqualTypeOf<string>();

// Methods return promises of the plain shapes above.
expectTypeOf<ReturnType<ChainAdapter['pay']>>().toEqualTypeOf<Promise<PayStep>>();
expectTypeOf<ReturnType<ChainAdapter['receipt']>>().toEqualTypeOf<Promise<ChainReceipt>>();
expectTypeOf<ReturnType<ChainAdapter['verifyReceipt']>>().toEqualTypeOf<
  Promise<ReceiptVerification>
>();
expectTypeOf<ReturnType<ChainAdapter['parseAddress']>>().toEqualTypeOf<ChainAddress>();
// Destinations come back as the pair the mandate binds, with a u64 tag as bigint.
expectTypeOf<ReturnType<ChainAdapter['parseDestination']>>().toEqualTypeOf<Destination>();
expectTypeOf<Parameters<ChainAdapter['parseDestination']>[0]>().toEqualTypeOf<RawDestination>();
expectTypeOf<
  Parameters<ChainAdapter['attestationMessage']>[0]
>().toEqualTypeOf<AttestationFields>();
expectTypeOf<ReturnType<ChainAdapter['attestationMessage']>>().toEqualTypeOf<Uint8Array>();
expectTypeOf<RawDestination>().toEqualTypeOf<{
  readonly address: string;
  readonly memoId?: string | undefined;
}>();
expectTypeOf<DestinationParseReason>().toEqualTypeOf<
  | 'MALFORMED'
  | 'CHECKSUM'
  | 'ZERO_ADDRESS'
  | 'MEMO_NOT_ID'
  | 'TAG_NOT_SUPPORTED'
  | 'TAG_OUT_OF_RANGE'
  | 'WRONG_NETWORK'
  | 'UNPAYABLE_ADDRESS'
>();
expectTypeOf<InvalidInputError['reason']>().toEqualTypeOf<DestinationParseReason | null>();
expectTypeOf<Parameters<ChainAdapter['verifyReceipt']>[0]>().toEqualTypeOf<ReceiptRef>();

// The config snapshot keeps fee limits as bigint.
type StellarConfig = NonNullable<NetworksConfig['stellar:pubnet']>;
expectTypeOf<StellarConfig['feeSponsor']['maxFeePerTxStroops']>().toEqualTypeOf<bigint>();
expectTypeOf<keyof NetworksConfig>().toEqualTypeOf<NetworkId>();

// Every store call that reads or writes a tenant's row takes the tenant.
// The sweep and the executor lease are platform operations and do not.
expectTypeOf<
  Parameters<AdapterStore['recordSubmission']>[0]['scope']
>().toEqualTypeOf<TenantScope>();
expectTypeOf<Parameters<AdapterStore['updateSubmission']>[0]>().toEqualTypeOf<TenantScope>();
expectTypeOf<Parameters<AdapterStore['liveSubmission']>[0]['scope']>().toEqualTypeOf<TenantScope>();
expectTypeOf<Parameters<AdapterStore['upsertDelivery']>[0]['scope']>().toEqualTypeOf<TenantScope>();
expectTypeOf<Parameters<AdapterStore['liveDelivery']>[0]>().toEqualTypeOf<TenantScope>();
// Sponsorship counters are per principal rows, so every policy call takes the tenant.
expectTypeOf<Parameters<SponsorshipPolicy['reserve']>[0]['scope']>().toEqualTypeOf<TenantScope>();
expectTypeOf<Parameters<SponsorshipPolicy['settle']>[0]['scope']>().toEqualTypeOf<TenantScope>();
expectTypeOf<Parameters<SponsorshipPolicy['release']>[0]['scope']>().toEqualTypeOf<TenantScope>();
expectTypeOf<
  Parameters<SponsorshipPolicy['settle']>[0]['actualFee']
>().toEqualTypeOf<NativeAmount>();
expectTypeOf<
  Parameters<SponsorshipPolicy['release']>[0]['reservationId']
>().toEqualTypeOf<string>();

// Every call that can reach the network takes CallOptions, so the
// correlation ID always travels.
expectTypeOf<Parameters<ChainAdapter['health']>[0]>().toEqualTypeOf<CallOptions>();
expectTypeOf<Parameters<ChainAdapter['pay']>[1]>().toEqualTypeOf<CallOptions>();
expectTypeOf<Parameters<ChainAdapter['fundingInstructions']>[1]>().toEqualTypeOf<CallOptions>();
expectTypeOf<Parameters<ChainAdapter['verifyReceipt']>[1]>().toEqualTypeOf<CallOptions>();
expectTypeOf<CallOptions['correlationId']>().toEqualTypeOf<string>();

// The payout fee and the full set of mandate operations and roles.
expectTypeOf<PayRequest['fee']>().toEqualTypeOf<TokenAmount>();
expectTypeOf<RoleName>().toEqualTypeOf<
  'agent' | 'approver' | 'guardian' | 'executor' | 'recovery'
>();
expectTypeOf<
  | 'set_recovery_threshold'
  | 'lower_fee_cap'
  | 'cancel_principal_proposal'
  | 'recovery_revoke'
  | 'recovery_rotate_agent'
>().toExtend<MandateAction['op']>();
expectTypeOf<Extract<MandateAction, { role: unknown }>['role']>().toEqualTypeOf<RoleName>();
expectTypeOf<
  Extract<MandateAction, { op: 'recovery_rotate_agent' }>['new']
>().toEqualTypeOf<ChainAddress | null>();
expectTypeOf<MandateAction['op']>().toExtend<SubmissionOp>();
expectTypeOf<'fund' | 'ttl_extend' | 'restore' | 'trustline'>().toExtend<SubmissionOp>();
expectTypeOf<SubmissionState>().toEqualTypeOf<
  'built' | 'broadcast' | 'unknown' | 'landed' | 'failed' | 'expired' | 'replaced'
>();
expectTypeOf<ExecutorLease['leaseId']>().toEqualTypeOf<string>();
expectTypeOf<LegDeliveryRecord['destination']>().toEqualTypeOf<{
  readonly address: ChainAddress;
  readonly tag: bigint | null;
}>();
expectTypeOf<MandateConfigInput['recipientMode']>().toEqualTypeOf<
  'allowlist' | 'attested' | 'both'
>();

// The mandate structs, mirrored with core types.
expectTypeOf<LimitsInput>().toEqualTypeOf<{
  readonly totalBudget: TokenAmount;
  readonly perPaymentCap: TokenAmount;
  readonly perRecipientDailyCap: TokenAmount;
  readonly approvalThreshold: TokenAmount;
  readonly payoutTtlSeconds: number;
  readonly expiresAt: UnixSeconds;
}>();
expectTypeOf<AllowEntryInput>().toEqualTypeOf<{
  readonly recipientRef: Bytes32;
  readonly destination: { readonly address: ChainAddress; readonly tag: bigint | null };
}>();
expectTypeOf<AttestationInput>().toEqualTypeOf<{
  readonly legIndex: number;
  readonly validUntil: UnixSeconds;
  readonly signature: Uint8Array;
}>();
// A patch can only move the state and record the outcome, never rewrite
// who, what or where.
expectTypeOf<keyof SubmissionPatch>().toEqualTypeOf<
  'state' | 'landedAtHeight' | 'errorCode' | 'specCode'
>();
expectTypeOf<SubmissionPatch['state']>().toEqualTypeOf<SubmissionState | undefined>();
expectTypeOf<SubmissionPatch['landedAtHeight']>().toEqualTypeOf<bigint | null | undefined>();
expectTypeOf<SubmissionPatch>().toExtend<Partial<SubmissionRecord>>();
