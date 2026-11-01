// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one transaction builder every Stellar contract call goes through:
// mandate calls, the factory's create, the funding transfer, TTL extensions
// and restores, and the fee bump that wraps them. A memo is not part of any
// input here, so none can be set, and every envelope is checked on the way
// out as well, so a later change to this file cannot quietly start sending
// one.

import {
  Account,
  Address,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-base';
import type { Transaction } from '@stellar/stellar-base';
import { I128_MAX } from '@ujira/core';
import { z } from 'zod';

import { checkEnvelopeMemo, checkNetwork, readTransactionEnvelope } from '../codecs/memo.js';
import { isAccountAddress, isContractAddress } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import { NETWORK_IDS } from '../networks.js';
import type { NetworkId, StellarNetworkId } from '../networks.js';

const PASSPHRASES: Readonly<Record<StellarNetworkId, string>> = Object.freeze({
  'stellar:pubnet': Networks.PUBLIC,
  'stellar:testnet': Networks.TESTNET,
});

/**
 * Every mandate function the adapter sends in a transaction, from the
 * mandate spec's operation list. Views are simulated and never sent, so
 * they are not here.
 */
export const MANDATE_FUNCTIONS = Object.freeze([
  'request_payout',
  'request_payouts',
  'approve',
  'reject',
  'cancel',
  'cancel_batch',
  'execute',
  'execute_batch',
  'pause',
  'resume',
  'revoke',
  'withdraw',
  'sweep',
  'recover_token',
  'update_limits',
  'add_role',
  'remove_role',
  'set_approvals_required',
  'set_recovery_threshold',
  'allow_recipients',
  'disallow_recipients',
  'set_attestation_policy',
  'propose_principal',
  'accept_principal',
  'cancel_principal_proposal',
  'lower_fee_cap',
  'recovery_revoke',
  'recovery_rotate_agent',
] as const);

export type MandateFunction = (typeof MANDATE_FUNCTIONS)[number];

/** One contract call. Arguments arrive encoded; there is no memo anywhere in it. */
export type ContractCall =
  | {
      readonly kind: 'invoke';
      /** The C address of the contract. */
      readonly contract: string;
      readonly method: string;
      readonly args: readonly xdr.ScVal[];
      /** Signed authorization entries, when the caller is not the transaction source. */
      readonly auth?: readonly xdr.SorobanAuthorizationEntry[];
    }
  | {
      readonly kind: 'extend_ttl';
      /** Ledgers from now the footprint's entries should live to. */
      readonly extendTo: number;
    }
  | { readonly kind: 'restore' };

/**
 * What a contract call transaction is built from. There is no memo field:
 * the network refuses a contract call that carries one.
 */
export interface ContractCallTransactionInput {
  readonly network: StellarNetworkId;
  /** The G account that sends it: the principal, or a channel account in the relayer form. */
  readonly source: string;
  /** The source account's current sequence number; the transaction uses the next one. */
  readonly sequence: bigint;
  /** Stroops per operation, on top of the resource fee in the simulation's data. */
  readonly inclusionFee: bigint;
  /** Unix seconds. A transaction always has an upper bound, so it cannot land long after it was meant to. */
  readonly timeBounds: { readonly minTime: bigint; readonly maxTime: bigint };
  /** Base64 SorobanTransactionData from a fresh simulation. */
  readonly sorobanData: string;
  readonly call: ContractCall;
}

export interface FeeBumpInput {
  readonly network: StellarNetworkId;
  /** The signed inner transaction, as base64 envelope XDR. */
  readonly inner: string;
  /** The G account that pays. */
  readonly feeSource: string;
  /** The most the fee source pays per operation, in stroops. */
  readonly fee: bigint;
}

const U32_MAX = 4_294_967_295n;
const U64_MAX = (1n << 64n) - 1n;
// The built transaction takes the next sequence number, which must still fit.
const MAX_SEQUENCE = (1n << 63n) - 2n;
// The network's minimum base fee.
const MIN_INCLUSION_FEE = 100n;
const MAX_ISSUES = 10;
const MAX_ARGS = 64;
const MAX_AUTH_ENTRIES = 20;
const MAX_SOROBAN_DATA_BASE64 = 65_536;
// A Soroban symbol: what a contract function name may be.
const SYMBOL = /^[A-Za-z0-9_]{1,32}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_]{1,32}$/;

const scVal = z.custom<xdr.ScVal>((value) => value instanceof xdr.ScVal);
const authEntry = z.custom<xdr.SorobanAuthorizationEntry>(
  (value) => value instanceof xdr.SorobanAuthorizationEntry,
);

const callSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('invoke'),
    contract: z.string().refine(isContractAddress),
    method: z.string().regex(SYMBOL),
    args: z.array(scVal).max(MAX_ARGS).readonly(),
    auth: z.array(authEntry).max(MAX_AUTH_ENTRIES).readonly().optional(),
  }),
  z.strictObject({
    kind: z.literal('extend_ttl'),
    extendTo: z.int().min(1).max(4_294_967_295),
  }),
  z.strictObject({ kind: z.literal('restore') }),
]);

const inputSchema = z.strictObject({
  network: z.enum(NETWORK_IDS),
  source: z.string().refine(isAccountAddress),
  sequence: z.bigint().min(0n).max(MAX_SEQUENCE),
  inclusionFee: z.bigint().min(MIN_INCLUSION_FEE).max(U32_MAX),
  timeBounds: z
    .strictObject({
      minTime: z.bigint().min(0n).max(U64_MAX),
      maxTime: z.bigint().min(1n).max(U64_MAX),
    })
    .refine((bounds) => bounds.minTime <= bounds.maxTime),
  sorobanData: z.string().min(1).max(MAX_SOROBAN_DATA_BASE64),
  call: callSchema,
});

const feeBumpSchema = z.strictObject({
  network: z.enum(NETWORK_IDS),
  inner: z.string(),
  feeSource: z.string().refine(isAccountAddress),
  fee: z.bigint().min(MIN_INCLUSION_FEE).max(U32_MAX),
});

function issuePath(path: readonly PropertyKey[]): string {
  // Paths hold declared keys and indexes only; anything else is named by
  // kind so no input text could be echoed into a log.
  return ['input', ...path]
    .map((segment) =>
      typeof segment === 'number' || (typeof segment === 'string' && SAFE_SEGMENT.test(segment))
        ? String(segment)
        : 'key',
    )
    .join('.');
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // zod messages can quote what they were given, so only paths and codes are kept.
  const issues = result.error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issuePath(issue.path)} (${issue.code})`);
  throw new InvalidInputError({ issues });
}

function invalid(path: string, code: string): InvalidInputError {
  return new InvalidInputError({ issues: [`input.${path} (${code})`] });
}

/** A call to a mandate function, with its arguments already encoded. */
export function mandateCall(
  mandate: string,
  fn: MandateFunction,
  args: readonly xdr.ScVal[],
): ContractCall {
  return { kind: 'invoke', contract: mandate, method: fn, args };
}

/** The factory's create, which deploys a mandate. */
export function factoryCreate(factory: string, args: readonly xdr.ScVal[]): ContractCall {
  return { kind: 'invoke', contract: factory, method: 'create', args };
}

/**
 * A funding transfer on the asset contract, from the principal to the
 * mandate, in the token's raw units.
 */
export function fundingTransfer(transfer: {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}): ContractCall {
  const { token, from, to, amount } = transfer;
  for (const [field, address] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (!isAccountAddress(address) && !isContractAddress(address)) {
      throw invalid(`call.${field}`, 'invalid_address');
    }
  }
  if (typeof amount !== 'bigint' || amount <= 0n || amount > I128_MAX) {
    throw invalid('call.amount', 'out_of_range');
  }
  return {
    kind: 'invoke',
    contract: token,
    method: 'transfer',
    args: [
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
    ],
  };
}

/** Extends the TTL of the entries in the simulated footprint. */
export function extendTtl(extendTo: number): ContractCall {
  return { kind: 'extend_ttl', extendTo };
}

/** Restores the archived entries in the simulated footprint. */
export function restoreArchived(): ContractCall {
  return { kind: 'restore' };
}

function operationOf(call: z.infer<typeof callSchema>): xdr.Operation {
  if (call.kind === 'extend_ttl') return Operation.extendFootprintTtl({ extendTo: call.extendTo });
  if (call.kind === 'restore') return Operation.restoreFootprint({});
  return Operation.invokeContractFunction({
    contract: call.contract,
    function: call.method,
    args: [...call.args],
    ...(call.auth === undefined ? {} : { auth: [...call.auth] }),
  });
}

function sorobanDataOf(text: string): xdr.SorobanTransactionData {
  try {
    return new SorobanDataBuilder(text).build();
  } catch {
    // The library's message can quote the input, so only the fact is kept.
    throw invalid('sorobanData', 'malformed');
  }
}

/** The base64 envelope of a transaction, after the memo check. */
function checkedEnvelope(envelope: xdr.TransactionEnvelope, network: NetworkId): string {
  checkEnvelopeMemo(envelope, network);
  return envelope.toXDR('base64');
}

/**
 * Builds the unsigned envelope of one contract call, as base64 XDR, with no
 * memo. Throws InvalidInputError, naming paths and codes only, on input it
 * cannot build from, including any field it does not know, a memo among
 * them.
 */
export function buildContractCallTransaction(input: ContractCallTransactionInput): string {
  const read = parsed(inputSchema, input);
  const data = sorobanDataOf(read.sorobanData);
  // The transaction fee is the inclusion fee plus the resource fee, and
  // the XDR holds it in 32 bits.
  if (read.inclusionFee + BigInt(data.resourceFee().toString()) > U32_MAX) {
    throw invalid('inclusionFee', 'out_of_range');
  }
  const tx = new TransactionBuilder(new Account(read.source, read.sequence.toString()), {
    fee: read.inclusionFee.toString(),
    networkPassphrase: PASSPHRASES[read.network],
    timebounds: {
      minTime: read.timeBounds.minTime.toString(),
      maxTime: read.timeBounds.maxTime.toString(),
    },
    sorobanData: data,
  })
    .addOperation(operationOf(read.call))
    .build();
  return checkedEnvelope(tx.toEnvelope(), read.network);
}

/**
 * Wraps a signed contract call in a fee bump paid by `feeSource`. The inner
 * transaction is checked for a memo before it is wrapped and the result
 * after, so a memo set anywhere upstream never reaches a sponsor's
 * signature. Throws MemoOnContractCallError or InvalidInputError.
 */
export function wrapInFeeBump(input: FeeBumpInput): string {
  const read = parsed(feeBumpSchema, input);
  const network = checkNetwork(read.network);
  const inner = readTransactionEnvelope(read.inner);
  // A fee bump wraps a plain transaction only, never another fee bump.
  if (inner.switch().name !== 'envelopeTypeTx') throw invalid('inner', 'wrong_envelope_type');
  checkEnvelopeMemo(inner, network);
  const passphrase = PASSPHRASES[read.network];
  const innerTx = TransactionBuilder.fromXDR(inner, passphrase) as Transaction;
  const bump = TransactionBuilder.buildFeeBumpTransaction(
    read.feeSource,
    read.fee.toString(),
    innerTx,
    passphrase,
  );
  return checkedEnvelope(bump.toEnvelope(), network);
}
