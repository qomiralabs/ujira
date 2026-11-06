// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The rules every Soroban transaction the adapter builds or sends follows, so
// that nothing the network says about resources is ever mistaken for a mandate
// decision. Simulation can under-report what the network charges, and entries
// can be archived between simulation and apply. Those failures are the
// network's, not the mandate's, so they are re-simulated, never reported as a
// rule. Only getTransaction proves that anything landed.

import { SorobanDataBuilder, xdr } from '@stellar/stellar-sdk/base';

import { InvalidInputError } from '../errors.js';
import type { NetworkId } from '../networks.js';

import type { RpcLedgerEntry } from './rpc.js';

/** The least padding that covers a caught transfer failure's extra writes. */
export const MIN_WRITE_BYTES_PADDING = 512;

/**
 * The mandate calls that may catch a transfer failure inside the mandate, and
 * so need write padding. Revoke moves no funds, so no current call does; the
 * mechanism stays for any future call that will.
 */
export const PADDED_CALLS: ReadonlySet<string> = new Set<string>();

export type ResourceFailure = 'resource_limit' | 'entry_archived';

function failureOfOperation(result: xdr.OperationResult | undefined): ResourceFailure | null {
  if (result?.type !== 'opInner' || result.tr.type !== 'invokeHostFunction') return null;
  switch (result.tr.invokeHostFunctionResult.type) {
    case 'invokeHostFunctionResourceLimitExceeded':
      return 'resource_limit';
    case 'invokeHostFunctionEntryArchived':
      return 'entry_archived';
    default:
      return null;
  }
}

/**
 * The resource failure a transaction result reports, or null for any other
 * outcome, including one that cannot be read. A sponsored transaction's result
 * is inside its fee bump.
 */
export function resourceFailureOf(resultXdr: string | undefined): ResourceFailure | null {
  if (resultXdr === undefined) return null;
  let result: xdr.TransactionResult;
  try {
    result = xdr.TransactionResult.fromXdr(resultXdr, 'base64');
  } catch {
    return null;
  }
  const outer = result.result;
  if (outer.type === 'txFailed') return failureOfOperation(outer.results[0]);
  if (outer.type === 'txFeeBumpInnerFailed') {
    const inner = outer.innerResultPair.result.result;
    return inner.type === 'txFailed' ? failureOfOperation(inner.results[0]) : null;
  }
  return null;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Adds write bytes to simulated resources, with the resource fee they cost,
 * before a principal signs. The footprint is kept exactly as simulated.
 */
export function padWriteBytes(
  sorobanData: string,
  input: {
    readonly network: NetworkId;
    readonly paddingBytes: number;
    readonly feeWrite1KB: bigint;
  },
): { readonly sorobanData: string; readonly addedFee: bigint } {
  if (!Number.isSafeInteger(input.paddingBytes) || input.paddingBytes < MIN_WRITE_BYTES_PADDING) {
    throw new InvalidInputError({
      network: input.network,
      issues: ['writeBytesPadding (too_small)'],
    });
  }
  const data = xdr.SorobanTransactionData.fromXdr(sorobanData, 'base64');
  const { instructions, diskReadBytes, writeBytes } = data.resources;
  const addedFee = ceilDiv(BigInt(input.paddingBytes) * input.feeWrite1KB, 1024n);
  const padded = new SorobanDataBuilder(data)
    .setResources(instructions, diskReadBytes, writeBytes + input.paddingBytes)
    .setResourceFee(data.resourceFee + addedFee)
    .build();
  return { sorobanData: padded.toXdr('base64'), addedFee };
}

function keyOfEntry(entry: xdr.LedgerEntry): string | null {
  const { data } = entry;
  if (data.type === 'contractData') {
    const { contract, key, durability } = data.contractData;
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({ contract, key, durability }),
    ).toXdr('base64');
  }
  if (data.type === 'contractCode') {
    return xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: data.contractCode.hash }),
    ).toXdr('base64');
  }
  return null;
}

function changesOf(meta: xdr.TransactionMeta): readonly xdr.LedgerEntryChange[] {
  if ('v4' in meta) {
    const { txChangesBefore, operations, txChangesAfter } = meta.v4;
    return [...txChangesBefore, ...operations.flatMap((op) => op.changes), ...txChangesAfter];
  }
  if ('v3' in meta) {
    const { txChangesBefore, operations, txChangesAfter } = meta.v3;
    return [...txChangesBefore, ...operations.flatMap((op) => op.changes), ...txChangesAfter];
  }
  // Older metadata predates restores, so it can list none.
  return [];
}

/** The entries a landed transaction's result lists as restored, as base64 ledger keys. */
export function restoredKeysOf(resultMetaXdr: string | undefined): readonly string[] {
  if (resultMetaXdr === undefined) return [];
  let meta: xdr.TransactionMeta;
  try {
    meta = xdr.TransactionMeta.fromXdr(resultMetaXdr, 'base64');
  } catch {
    return [];
  }
  const keys = new Set<string>();
  for (const change of changesOf(meta)) {
    if (change.type !== 'ledgerEntryRestored') continue;
    const key = keyOfEntry(change.restored);
    if (key !== null) keys.add(key);
  }
  return [...keys];
}

/** A TTL extension after a restore is one step per network, mandate and ledger. */
export function ttlExtensionKey(network: NetworkId, mandate: string, ledger: number): string {
  return `${network}:${mandate}:ttl_extend:${String(ledger)}`;
}

/** Where an idempotent step is remembered. Production backs this with the database. */
export interface StepLog {
  isDone(key: string): Promise<boolean>;
  markDone(key: string): Promise<void>;
}

export function createMemoryStepLog(): StepLog {
  const done = new Set<string>();
  return {
    isDone: (key) => Promise.resolve(done.has(key)),
    markDone: (key) => {
      done.add(key);
      return Promise.resolve();
    },
  };
}

export type LedgerEntryState =
  | { readonly state: 'absent' }
  | { readonly state: 'archived'; readonly entry: RpcLedgerEntry }
  | { readonly state: 'live'; readonly entry: RpcLedgerEntry };

/**
 * What a read found. A live-until ledger of zero means the entry is present and
 * archived, never absent: an archived tombstone still counts as a used payout
 * ID, and reading it as absent would allow that ID to be paid again.
 */
export function ledgerEntryState(entry: RpcLedgerEntry | undefined): LedgerEntryState {
  if (entry === undefined) return { state: 'absent' };
  return entry.liveUntilLedgerSeq === 0 ? { state: 'archived', entry } : { state: 'live', entry };
}

/**
 * True when the padding has been validated against the running stellar-rpc
 * version. A version the nightly check has not passed on is an alert, because
 * the padding's size is only known to be enough for a version it ran against.
 */
export function checkPaddingValidated(input: {
  readonly network: NetworkId;
  readonly rpcVersion: string;
  readonly lastPassingVersion: string | null;
  readonly alert: (e: {
    readonly network: NetworkId;
    readonly rpcVersion: string;
    readonly lastPassingVersion: string | null;
  }) => void;
}): boolean {
  if (input.rpcVersion === input.lastPassingVersion) return true;
  input.alert({
    network: input.network,
    rpcVersion: input.rpcVersion,
    lastPassingVersion: input.lastPassingVersion,
  });
  return false;
}
