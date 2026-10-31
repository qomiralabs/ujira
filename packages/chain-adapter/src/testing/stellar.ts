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

function build(account: Account | MuxedAccount, network: NetworkId, operations: xdr.Operation[]) {
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(network),
    timebounds: { minTime: 0, maxTime: MAX_TIME },
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
}

/** An unsigned Soroban authorization entry with address credentials, as base64 XDR. */
export function testAuthEntryXdr(options: TestAuthEntryOptions): string {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(options.contract ?? TEST_CONTRACT).toScAddress(),
        functionName: options.functionName ?? 'execute',
        args: [xdr.ScVal.scvU32(1)],
      }),
    ),
    subInvocations: [],
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
}

/**
 * A SEP-10 challenge as an anchor sends it, before either side signs: the
 * server's transaction at sequence 0, a manage data operation from the
 * client naming the home domain, and the web auth domain from the server.
 */
export function testSep10ChallengeXdr(options: TestSep10Options): string {
  const domain = options.homeDomain ?? 'anchor.example';
  const tx = build(accountAt(options.server, 0n), options.network ?? 'stellar:testnet', [
    Operation.manageData({
      name: `${domain} auth`,
      value: 'A'.repeat(64),
      source: options.client,
    }),
    Operation.manageData({ name: 'web_auth_domain', value: domain, source: options.server }),
  ]);
  return tx.toEnvelope().toXDR('base64');
}
