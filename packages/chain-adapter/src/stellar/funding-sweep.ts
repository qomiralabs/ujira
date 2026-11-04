// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The transfer that sweeps a deposit from a forwarding account into the
// mandate. The principal needs no XLM for it: in the relayer form UJIRA's
// sponsor is the transaction source and the principal signs only an
// authorization entry, for exactly this transfer and with a short expiry,
// so a signature that leaks or is held back cannot be used for anything
// else or much later. The fee bump form is the fallback for a wallet that
// cannot sign an entry. A contract call carries no memo, so none is set.

import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-base';
import { I128_MAX } from '@ujira/core';
import { z } from 'zod';

import { checkNetwork, networkPassphrase } from '../codecs/network.js';
import { isAccountAddress, isContractAddress } from '../codecs/strkey.js';
import { readXdr } from '../codecs/xdr.js';
import { InvalidInputError, SignedPayloadMismatchError } from '../errors.js';
import { NETWORK_IDS } from '../networks.js';
import type { StellarNetworkId } from '../networks.js';

import { buildContractCallTransaction } from './contract-call.js';

/** About an hour of ledgers. A sweep signature is prompted for and used at once. */
export const MAX_SWEEP_AUTH_LEDGERS = 720;

const U32_MAX = 4_294_967_295n;
const U32_MAX_NUMBER = 4_294_967_295;
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
// The built transaction takes the next sequence number, which must still fit.
const MAX_SEQUENCE = I64_MAX - 1n;
const MIN_INCLUSION_FEE = 100n;
const MAX_ISSUES = 10;
const MAX_SOROBAN_DATA_BASE64 = 65_536;

const contract = z.string().refine(isContractAddress);
const account = z.string().refine(isAccountAddress);
const amount = z.bigint().min(1n).max(I128_MAX);

const transferFields = {
  network: z.enum(NETWORK_IDS),
  token: contract,
  forwarder: account,
  mandate: contract,
  amount,
};

const authSchema = z.strictObject({
  ...transferFields,
  nonce: z.bigint().min(0n).max(I64_MAX),
  latestLedger: z.int().min(0).max(U32_MAX_NUMBER),
  expiresInLedgers: z.int().min(1).max(MAX_SWEEP_AUTH_LEDGERS),
});

const buildFields = {
  ...transferFields,
  inclusionFee: z.bigint().min(MIN_INCLUSION_FEE).max(U32_MAX),
  timeBounds: z
    .strictObject({
      minTime: z.bigint().min(0n).max(U64_MAX),
      maxTime: z.bigint().min(1n).max(U64_MAX),
    })
    .refine((bounds) => bounds.minTime <= bounds.maxTime),
  sorobanData: z.string().min(1).max(MAX_SOROBAN_DATA_BASE64),
};

const relayerSchema = z
  .strictObject({
    ...buildFields,
    sponsor: account,
    sponsorSequence: z.bigint().min(0n).max(MAX_SEQUENCE),
    signedAuthEntry: z.string(),
  })
  .refine((input) => input.sponsor !== input.forwarder, { path: ['sponsor'] });

const feeBumpSchema = z.strictObject({
  ...buildFields,
  forwarderSequence: z.bigint().min(0n).max(MAX_SEQUENCE),
});

interface SweepTransfer {
  readonly network: StellarNetworkId;
  /** The asset contract. */
  readonly token: string;
  readonly forwarder: string;
  readonly mandate: string;
  /** Raw token units. */
  readonly amount: bigint;
}

export interface SweepAuthInput extends SweepTransfer {
  /** A fresh random nonce, unique for this forwarding account. */
  readonly nonce: bigint;
  /** From the same simulation as the transaction. */
  readonly latestLedger: number;
  /** At most MAX_SWEEP_AUTH_LEDGERS. */
  readonly expiresInLedgers: number;
}

interface SweepBuildInput extends SweepTransfer {
  /** Stroops, on top of the resource fee in the simulation's data. */
  readonly inclusionFee: bigint;
  readonly timeBounds: { readonly minTime: bigint; readonly maxTime: bigint };
  /** Base64 SorobanTransactionData from a fresh simulation. */
  readonly sorobanData: string;
}

export interface SweepTransactionInput extends SweepBuildInput {
  readonly sponsor: string;
  /** The sponsor's current sequence number; the transaction uses the next one. */
  readonly sponsorSequence: bigint;
  /** The entry from sweepAuthEntry with the principal's signature in it. */
  readonly signedAuthEntry: string;
}

export interface SweepFeeBumpInput extends SweepBuildInput {
  /** The forwarding account's current sequence number. */
  readonly forwarderSequence: bigint;
}

// zod messages can quote what they were given, so only paths and codes are kept.
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new InvalidInputError({
    issues: result.error.issues
      .slice(0, MAX_ISSUES)
      .map((issue) => `${['input', ...issue.path.map(String)].join('.')} (${issue.code})`),
  });
}

function transferArguments(transfer: SweepTransfer): xdr.ScVal[] {
  return [
    new Address(transfer.forwarder).toScVal(),
    new Address(transfer.mandate).toScVal(),
    nativeToScVal(transfer.amount, { type: 'i128' }),
  ];
}

function transferInvocation(transfer: SweepTransfer): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(transfer.token).toScAddress(),
        functionName: 'transfer',
        args: transferArguments(transfer),
      }),
    ),
    subInvocations: [],
  });
}

/**
 * The authorization entry the principal signs, as base64 XDR, unsigned. Its
 * only invocation is this transfer and it expires shortly.
 */
export function sweepAuthEntry(input: SweepAuthInput): string {
  const read = parsed(authSchema, input);
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(read.forwarder).toScAddress(),
        nonce: xdr.Int64.fromString(read.nonce.toString()),
        signatureExpirationLedger: read.latestLedger + read.expiresInLedgers,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: transferInvocation(read),
  }).toXDR('base64');
}

// The entry came back from a wallet, and the sponsor pays to send it. It
// must be this forwarding account authorizing exactly this transfer with a
// signature present, or the chain would refuse it at the sponsor's cost.
function checkSignedEntry(entry: xdr.SorobanAuthorizationEntry, read: SweepTransfer): void {
  const refuse = (): SignedPayloadMismatchError =>
    new SignedPayloadMismatchError({ network: read.network });
  const credentials = entry.credentials();
  if (credentials.switch().name !== 'sorobanCredentialsAddress') throw refuse();
  const address = credentials.address();
  if (Address.fromScAddress(address.address()).toString() !== read.forwarder) throw refuse();
  if (address.signature().switch().name === 'scvVoid') throw refuse();
  if (entry.rootInvocation().toXDR('base64') !== transferInvocation(read).toXDR('base64')) {
    throw refuse();
  }
}

// Through the one builder every contract call uses, so the rule that a
// contract call carries no memo is checked here as well.
function buildInvoke(
  source: string,
  sequence: bigint,
  read: SweepBuildInput,
  auth: readonly xdr.SorobanAuthorizationEntry[],
): string {
  return buildContractCallTransaction({
    network: read.network,
    source,
    sequence,
    inclusionFee: read.inclusionFee,
    timeBounds: read.timeBounds,
    sorobanData: read.sorobanData,
    call: {
      kind: 'invoke',
      contract: read.token,
      method: 'transfer',
      args: transferArguments(read),
      auth,
    },
  });
}

/**
 * The relayer form: UJIRA's sponsor is the source and pays, and the only
 * authorization is the principal's signed entry. Throws
 * SignedPayloadMismatchError for an entry that is not this transfer, is not
 * signed, or does not come from the forwarding account.
 */
export function buildSweepRelayerTransaction(input: SweepTransactionInput): string {
  const read = parsed(relayerSchema, input);
  const entry = readXdr(read.signedAuthEntry, 'signedAuthEntry', (text) =>
    xdr.SorobanAuthorizationEntry.fromXDR(text, 'base64'),
  );
  checkSignedEntry(entry, read);
  return buildInvoke(read.sponsor, read.sponsorSequence, read, [entry]);
}

/**
 * The fallback: the forwarding account is the source, so its transaction
 * signature is the authorization, and UJIRA's sponsor wraps the signed
 * transaction in a fee bump so the principal still needs no XLM.
 */
export function buildSweepFeeBumpInner(input: SweepFeeBumpInput): string {
  const read = parsed(feeBumpSchema, input);
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: transferInvocation(read),
  });
  return buildInvoke(read.forwarder, read.forwarderSequence, read, [entry]);
}

/** What a signed sweep envelope itself says, for the row and the retry to rely on. */
export interface SweepEnvelopeFacts {
  /** Hex, of the envelope as sent: the outer hash for a fee bump. */
  readonly txHash: string;
  /** The transaction's upper time bound, in Unix seconds. */
  readonly validUntilSeconds: bigint;
  /** The last ledger its signed authorization entry is good in, or null for source credentials. */
  readonly authExpiresLedger: number | null;
}

function refusedEnvelope(code: string): InvalidInputError {
  return new InvalidInputError({ issues: [`xdr (${code})`] });
}

/**
 * Reads the facts the sweep worker writes to its row from the envelope, so they
 * are the ones on the transaction that is really sent. Every sweep has an upper
 * time bound, so an envelope with none is refused rather than recorded as one
 * that can never be shown dead.
 */
export function describeSweepEnvelope(
  envelopeXdr: string,
  network: StellarNetworkId,
): SweepEnvelopeFacts {
  const checked = checkNetwork(network);
  const envelope = readXdr(envelopeXdr, 'xdr', (text) =>
    xdr.TransactionEnvelope.fromXDR(text, 'base64'),
  );
  if (envelope.switch().name === 'envelopeTypeTxV0') throw refusedEnvelope('wrong_envelope_type');
  const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase(checked));
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const maxTime = BigInt(inner.timeBounds?.maxTime ?? '0');
  if (maxTime === 0n) throw refusedEnvelope('no_time_bound');
  const operations = inner.toEnvelope().v1().tx().operations();
  const [operation] = operations;
  if (operation?.body().switch().name !== 'invokeHostFunction' || operations.length !== 1) {
    throw refusedEnvelope('not_a_sweep');
  }
  const expiries = operation
    .body()
    .invokeHostFunctionOp()
    .auth()
    .map((entry) => entry.credentials())
    .filter((credentials) => credentials.switch().name === 'sorobanCredentialsAddress')
    .map((credentials) => credentials.address().signatureExpirationLedger());
  return Object.freeze({
    txHash: tx.hash().toString('hex'),
    validUntilSeconds: maxTime,
    authExpiresLedger: expiries.length === 0 ? null : Math.max(...expiries),
  });
}
