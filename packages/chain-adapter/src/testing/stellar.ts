// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Stellar envelopes for tests: a transaction, a fee bump, a Soroban
// authorization entry and a SEP-10 challenge, each built for whatever
// account a test names. Code outside this package may not load a Stellar
// library, so a signer's tests get their envelopes from here and read them
// back through the codecs. Time bounds and amounts are fixed so the same
// inputs always give the same XDR.

import {
  Account,
  Address,
  Asset,
  MuxedAccount,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-base';

import { networkPassphrase } from '../codecs/network.js';
import type { NetworkId } from '../networks.js';

/** The worked example destination of the contract spec, a plain testnet account. */
export const TEST_DESTINATION = 'GDTYAUMMX45E2SU2Q7JRJHCXDIYTEUAXVBHZ7DVCVXZGMAKMWFL7SOY4';
/** An account that sources the inner transaction of a test fee bump. */
export const TEST_INNER_SOURCE = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
/** The mandate of the contract spec's worked example, the contract a test entry invokes. */
export const TEST_CONTRACT = 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA';

// Far in the future, so a test envelope never reads as expired.
const MAX_TIME = 4_102_444_800;
const BASE_FEE = '100';

export interface TestTransactionOptions {
  /** The transaction source, a G or M address. */
  readonly source: string;
  readonly network?: NetworkId;
  /** The sequence number the transaction carries. */
  readonly sequence?: bigint;
  /** A source for the payment operation itself, when it differs from the transaction's. */
  readonly operationSource?: string;
}

interface BuildOptions {
  readonly timeBounds?: { readonly minTime: number; readonly maxTime: number } | undefined;
  /** Stroops per operation. */
  readonly feePerOperation?: number;
}

function build(
  account: Account | MuxedAccount,
  network: NetworkId,
  operations: xdr.Operation[],
  options: BuildOptions = {},
) {
  const builder = new TransactionBuilder(account, {
    fee: options.feePerOperation === undefined ? BASE_FEE : String(options.feePerOperation),
    networkPassphrase: networkPassphrase(network),
    timebounds: options.timeBounds ?? { minTime: 0, maxTime: MAX_TIME },
  });
  for (const operation of operations) builder.addOperation(operation);
  return builder.build();
}

// The builder adds one to the account's sequence, so it starts one below.
// The library takes an M address only as a muxed account.
function accountAt(source: string, sequence: bigint): Account | MuxedAccount {
  const before = (sequence - 1n).toString();
  return source.startsWith('M')
    ? MuxedAccount.fromAddress(source, before)
    : new Account(source, before);
}

function payment(source?: string): xdr.Operation {
  return Operation.payment({
    destination: TEST_DESTINATION,
    asset: Asset.native(),
    amount: '1',
    ...(source === undefined ? {} : { source }),
  });
}

/** An unsigned payment transaction from `source`, as base64 XDR. */
export function testTransactionXdr(options: TestTransactionOptions): string {
  const network = options.network ?? 'stellar:testnet';
  const tx = build(accountAt(options.source, options.sequence ?? 101n), network, [
    payment(options.operationSource),
  ]);
  return tx.toEnvelope().toXDR('base64');
}

export interface TestFeeBumpOptions {
  /** The account that pays the fee and signs the outer envelope. */
  readonly feeSource: string;
  readonly network?: NetworkId;
  /** The inner transaction's source; TEST_INNER_SOURCE when left out. */
  readonly innerSource?: string;
}

/** A fee bump around an unsigned payment, with no outer signature, as base64 XDR. */
export function testFeeBumpXdr(options: TestFeeBumpOptions): string {
  const network = options.network ?? 'stellar:testnet';
  const inner = build(accountAt(options.innerSource ?? TEST_INNER_SOURCE, 7n), network, [
    payment(),
  ]);
  const bump = TransactionBuilder.buildFeeBumpTransaction(
    options.feeSource,
    '200',
    inner,
    networkPassphrase(network),
  );
  return bump.toEnvelope().toXDR('base64');
}

export interface TestAuthEntryOptions {
  /** The address the entry's credentials name, which must sign it. */
  readonly address: string;
  readonly contract?: string;
  readonly functionName?: string;
  readonly nonce?: bigint;
  /** Nests one call to `transfer` under the root call. */
  readonly nested?: boolean;
}

function contractCall(contract: string, functionName: string): xdr.SorobanAuthorizedFunction {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contract).toScAddress(),
      functionName,
      args: [xdr.ScVal.scvU32(1)],
    }),
  );
}

/** An unsigned Soroban authorization entry with address credentials, as base64 XDR. */
export function testAuthEntryXdr(options: TestAuthEntryOptions): string {
  const contract = options.contract ?? TEST_CONTRACT;
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: contractCall(contract, options.functionName ?? 'execute'),
    subInvocations:
      options.nested === true
        ? [
            new xdr.SorobanAuthorizedInvocation({
              function: contractCall(contract, 'transfer'),
              subInvocations: [],
            }),
          ]
        : [],
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(options.address).toScAddress(),
        nonce: xdr.Int64.fromString((options.nonce ?? 42n).toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  });
  return entry.toXDR('base64');
}

export interface TestSep10Options {
  /** The anchor's signing account, the challenge's source. */
  readonly server: string;
  /** The account logging in, the source of the first operation. */
  readonly client: string;
  readonly network?: NetworkId;
  readonly homeDomain?: string;
  /** The web_auth_domain value; the home domain when left out. */
  readonly webAuthDomain?: string;
  /** Unix seconds; 0 to far in the future when left out. */
  readonly timeBounds?: { readonly minTime: number; readonly maxTime: number };
  /** Adds a payment from the client after the manage data operations. */
  readonly withPayment?: boolean;
  /** The sequence the challenge carries; 0 when left out. */
  readonly sequence?: bigint;
}

/**
 * A SEP-10 challenge as an anchor sends it, before either side signs: the
 * server's transaction at sequence 0, a manage data operation from the
 * client naming the home domain, and the web auth domain from the server.
 */
export function testSep10ChallengeXdr(options: TestSep10Options): string {
  const domain = options.homeDomain ?? 'anchor.example';
  const operations = [
    Operation.manageData({
      name: `${domain} auth`,
      value: 'A'.repeat(64),
      source: options.client,
    }),
    Operation.manageData({
      name: 'web_auth_domain',
      value: options.webAuthDomain ?? domain,
      source: options.server,
    }),
  ];
  if (options.withPayment === true) operations.push(payment(options.client));
  const tx = build(
    accountAt(options.server, options.sequence ?? 0n),
    options.network ?? 'stellar:testnet',
    operations,
    { timeBounds: options.timeBounds },
  );
  return tx.toEnvelope().toXDR('base64');
}

export interface TestInvokeOptions {
  /** The transaction source, which pays the fee. */
  readonly source: string;
  readonly network?: NetworkId;
  /** One call per entry, each on its contract. */
  readonly calls: readonly { readonly contract: string; readonly functionName: string }[];
  /** Stroops per operation; 100 when left out. */
  readonly feePerOperation?: number;
}

/** An unsigned transaction of Soroban contract calls, as base64 XDR. */
export function testInvokeXdr(options: TestInvokeOptions): string {
  const operations = options.calls.map((call) =>
    Operation.invokeContractFunction({
      contract: call.contract,
      function: call.functionName,
      args: [xdr.ScVal.scvU32(1)],
    }),
  );
  const tx = build(
    accountAt(options.source, 11n),
    options.network ?? 'stellar:testnet',
    operations,
    options.feePerOperation === undefined ? {} : { feePerOperation: options.feePerOperation },
  );
  return tx.toEnvelope().toXDR('base64');
}

/** The operations a sponsorship sandwich can hold, in the order a test lists them. */
export type SandwichStep = 'begin' | 'create' | 'trust' | 'end' | 'payment';

export interface TestSandwichOptions {
  /** The fee sponsor, the transaction source. */
  readonly sponsor: string;
  /** The account whose reserves are sponsored. */
  readonly sponsored: string;
  readonly network?: NetworkId;
  /** The asset of the trust line. */
  readonly asset: { readonly code: string; readonly issuer: string };
  readonly steps?: readonly SandwichStep[];
  /** Seconds from minTime to maxTime; 300 when left out. */
  readonly validitySeconds?: number;
  /** The fee in stroops per operation; 100 when left out. */
  readonly feePerOperation?: number;
}

/**
 * The fee sponsor's transaction that opens and funds an account at no cost
 * to it: begin sponsoring, create the account with no balance, add the
 * payout asset's trust line and end sponsoring, with the sponsor as source
 * except where the sponsored account must act.
 */
export function testReserveSandwichXdr(options: TestSandwichOptions): string {
  const { sponsor, sponsored } = options;
  const asset = new Asset(options.asset.code, options.asset.issuer);
  const step = (name: SandwichStep): xdr.Operation => {
    switch (name) {
      case 'begin':
        return Operation.beginSponsoringFutureReserves({ sponsoredId: sponsored, source: sponsor });
      case 'create':
        return Operation.createAccount({
          destination: sponsored,
          startingBalance: '0',
          source: sponsor,
        });
      case 'trust':
        return Operation.changeTrust({ asset, source: sponsored });
      case 'end':
        return Operation.endSponsoringFutureReserves({ source: sponsored });
      case 'payment':
        return payment(sponsor);
    }
  };
  const steps = options.steps ?? ['begin', 'create', 'trust', 'end'];
  const validity = options.validitySeconds ?? 300;
  const minTime = 1_900_000_000;
  const tx = build(accountAt(sponsor, 21n), options.network ?? 'stellar:testnet', steps.map(step), {
    timeBounds: { minTime, maxTime: minTime + validity },
    feePerOperation: options.feePerOperation ?? 100,
  });
  return tx.toEnvelope().toXDR('base64');
}
