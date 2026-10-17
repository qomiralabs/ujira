// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compile time checks on the public types, run by typecheck. No chain SDK
// is a dependency of this package, so an SDK type in a signature would fail
// to resolve and collapse to any; every exported shape is pinned to plain
// strings, bigints and core money types instead, and checked not to be any.

import type { Chain, FiatCurrencyCode, Money, TokenAmount, TokenAsset } from '@ujira/core';
import { expectTypeOf } from 'vitest';

import type {
  AdapterCapabilities,
  AdapterPorts,
  AdapterStore,
  BatchStep,
  ChainAdapter,
  ChainAdapterErrorJson,
  ChainAddress,
  ChainHealth,
  ChainReceipt,
  DeadProof,
  Deposit,
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

// The network and chain are closed unions of plain strings.
expectTypeOf<NetworkId>().toEqualTypeOf<
  'stellar:pubnet' | 'stellar:testnet' | 'eip155:42220' | 'eip155:11142220'
>();
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
  Extract<SigningRequest, { kind: 'evm_transaction' }>['tx']['data']
>().toEqualTypeOf<string>();
expectTypeOf<
  Extract<SigningRequest, { kind: 'evm_transaction' }>['tx']['gas']
>().toEqualTypeOf<bigint>();

// Methods return promises of the plain shapes above.
expectTypeOf<ReturnType<ChainAdapter['pay']>>().toEqualTypeOf<Promise<PayStep>>();
expectTypeOf<ReturnType<ChainAdapter['receipt']>>().toEqualTypeOf<Promise<ChainReceipt>>();
expectTypeOf<ReturnType<ChainAdapter['verifyReceipt']>>().toEqualTypeOf<
  Promise<ReceiptVerification>
>();
expectTypeOf<ReturnType<ChainAdapter['parseAddress']>>().toEqualTypeOf<ChainAddress>();
expectTypeOf<Parameters<ChainAdapter['verifyReceipt']>[0]>().toEqualTypeOf<ReceiptRef>();

// The config snapshot keeps fee limits as bigint.
type StellarConfig = NonNullable<NetworksConfig['stellar:pubnet']>;
type CeloConfig = NonNullable<NetworksConfig['eip155:42220']>;
expectTypeOf<StellarConfig['feeSponsor']['maxFeePerTxStroops']>().toEqualTypeOf<bigint>();
expectTypeOf<CeloConfig['executor']['maxFeePerGasCapWei']>().toEqualTypeOf<bigint>();
expectTypeOf<NetworksConfig['eip155:1' & keyof NetworksConfig]>().toBeNever();
