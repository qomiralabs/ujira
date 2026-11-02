// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Moves each deposit on a forwarding account into the mandate, exactly once.
// A sweep is a money move, so the deposit's operation id is its permanent
// idempotency key: a repeated deposit event finds the row already there, a
// retried job does not prompt the principal again, and a second send is
// refused by the row's state before it reaches the chain. The transaction
// hash is written before the send, so a crash leaves a sweep to reconcile
// rather than one that could go out twice.
//
// This package knows no chain. What is sent and how it is built is the chain
// adapter's, behind the SweepChain port.

import { isChainAdapterError } from '@ujira/chain-adapter';
import { chainOf, isNetworkId } from '@ujira/chain-adapter';
import type { NetworkId } from '@ujira/chain-adapter';
import { equals, isNegative, isZero } from '@ujira/core';
import type { Chain, TokenAmount } from '@ujira/core';
import { z } from 'zod';

import {
  FundingInputError,
  SweepStateError,
  SweepTenantError,
  SweepTimeoutError,
} from './errors.js';

export const SWEEP_STATUSES = Object.freeze([
  'awaiting_signature',
  'submitted',
  'confirmed',
  'failed',
] as const);

export type SweepStatus = (typeof SWEEP_STATUSES)[number];

export type SweepFailureReason = 'insufficient_balance' | 'no_matching_transfer' | 'rejected';

export interface SweepScope {
  readonly principalId: string;
  readonly projectId: string;
}

/** The asset contract transfer that funded the mandate. */
export interface SweepFundingReference {
  readonly txHash: string;
  readonly eventIndex: number;
  /** The mandate. */
  readonly to: string;
}

/** One deposit's sweep, as stored. Tenant on the row. */
export interface SweepRecord {
  readonly principalId: string;
  readonly projectId: string;
  readonly chain: Chain;
  readonly network: NetworkId;
  /** The idempotency key, unique per chain. */
  readonly depositOperationId: string;
  readonly forwarder: string;
  readonly mandate: string;
  readonly amount: TokenAmount;
  readonly status: SweepStatus;
  readonly txHash: string | null;
  readonly failureReason: SweepFailureReason | null;
  readonly funding: SweepFundingReference | null;
  /** When the principal's prompt was queued, as a bigint of Unix seconds. */
  readonly promptedAt: bigint | null;
}

export interface SweepKey {
  readonly scope: SweepScope;
  readonly network: NetworkId;
  readonly depositOperationId: string;
}

export interface SweepPatch {
  readonly status: SweepStatus;
  readonly txHash?: string;
  readonly failureReason?: SweepFailureReason;
  readonly funding?: SweepFundingReference;
}

/**
 * The sweeps table. Unique on chain and deposit operation id. Every read and
 * write is by tenant, so another tenant's row reads as absent.
 */
export interface SweepStore {
  /** Inserts the row unless the chain and deposit id exist; returns whichever row holds them. */
  insertIfAbsent(row: SweepRecord): Promise<SweepRecord>;
  get(key: SweepKey): Promise<SweepRecord | null>;
  markPrompted(key: SweepKey, at: bigint): Promise<void>;
  /** Moves the row only from `from`. Throws SweepStateError otherwise. */
  transition(key: SweepKey, from: SweepStatus, patch: SweepPatch): Promise<SweepRecord>;
}

export interface SweepPrompt {
  readonly scope: SweepScope;
  readonly network: NetworkId;
  readonly depositOperationId: string;
  readonly forwarder: string;
  readonly mandate: string;
  readonly amount: TokenAmount;
}

/**
 * Queues the principal's prompt, in the outbox. The key makes a repeat a
 * no-op there, which is what makes one prompt per deposit hold across a crash
 * between queuing it and marking the row.
 */
export interface SweepPrompts {
  requestSignature(prompt: SweepPrompt, idempotencyKey: string): Promise<void>;
}

export interface SweepTransferEvent {
  readonly eventIndex: number;
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: TokenAmount;
}

export type SweepChainResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'landed'; readonly transfers: readonly SweepTransferEvent[] }
  | { readonly kind: 'failed'; readonly reason: 'insufficient_balance' | 'rejected' };

/** The chain adapter's side: the hash of a signed payload, its send and its result. */
export interface SweepChain {
  hashOf(signedPayload: string): string;
  submit(signedPayload: string, signal: AbortSignal): Promise<void>;
  result(txHash: string, signal: AbortSignal): Promise<SweepChainResult>;
}

/** What a person should look at. A duplicate cannot double fund, but it is not normal. */
export interface SweepReports {
  sweepFailed(event: {
    readonly principalId: string;
    readonly projectId: string;
    readonly network: NetworkId;
    readonly depositOperationId: string;
    readonly reason: SweepFailureReason;
  }): void;
}

export interface SweepPorts {
  readonly store: SweepStore;
  readonly prompts: SweepPrompts;
  readonly chain: SweepChain;
  readonly reports: SweepReports;
}

export interface SweepOptions {
  /** How long to wait for the chain, in whole milliseconds. */
  readonly timeoutMs: number;
  /** The asset contract a confirming transfer must come from. */
  readonly token: string;
}

export interface DepositEvent {
  readonly scope: SweepScope;
  readonly network: NetworkId;
  /** The operation id of the incoming payment. */
  readonly depositOperationId: string;
  readonly forwarder: string;
  readonly mandate: string;
  readonly amount: TokenAmount;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Operation ids are decimal integers on the chains UJIRA settles on.
const OPERATION_ID = /^[0-9]{1,32}$/;
const MAX_TIMEOUT_MS = 120_000;
const MAX_ISSUES = 10;

const scopeSchema = z.strictObject({
  principalId: z.string().regex(UUID),
  projectId: z.string().regex(UUID),
});
const networkSchema = z.custom<NetworkId>(isNetworkId);
const address = z.string().min(1).max(128);
const amountSchema = z.custom<TokenAmount>(isPositiveToken);

const depositSchema = z.strictObject({
  scope: scopeSchema,
  network: networkSchema,
  depositOperationId: z.string().regex(OPERATION_ID),
  forwarder: address,
  mandate: address,
  amount: amountSchema,
});

const keySchema = z.strictObject({
  scope: scopeSchema,
  network: networkSchema,
  depositOperationId: z.string().regex(OPERATION_ID),
});

const submitSchema = keySchema.extend({ signedPayload: z.string().min(1).max(350_000) });

const optionsSchema = z.strictObject({
  timeoutMs: z.int().min(1).max(MAX_TIMEOUT_MS),
  token: address,
});

// The money module validates a value of any shape and throws on a forged one.
function isPositiveToken(value: unknown): boolean {
  try {
    const kind: unknown = (value as { readonly kind?: unknown }).kind;
    const token = value as TokenAmount;
    return kind === 'token' && !isZero(token) && !isNegative(token);
  } catch {
    return false;
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, root: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // zod messages can quote what they were given, so only paths and codes are kept.
  throw new FundingInputError(
    result.error.issues
      .slice(0, MAX_ISSUES)
      .map((issue) => `${[root, ...issue.path.map(String)].join('.')} (${issue.code})`),
  );
}

// Gives up at the deadline even if the port ignores the signal.
async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SweepTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function promptKey(row: SweepRecord): string {
  return `sweep:${row.chain}:${row.depositOperationId}`;
}

function nowSeconds(): bigint {
  return BigInt(Date.now()) / 1000n;
}

/**
 * Records a deposit and prompts the principal once. Safe to call for every
 * sighting of the same deposit. Throws SweepTenantError when the deposit is
 * already recorded under another tenant.
 */
export async function recordDeposit(event: DepositEvent, ports: SweepPorts): Promise<SweepRecord> {
  const read = parsed(depositSchema, event, 'deposit');
  const { principalId, projectId } = read.scope;
  const row = await ports.store.insertIfAbsent({
    principalId,
    projectId,
    chain: chainOf(read.network),
    network: read.network,
    depositOperationId: read.depositOperationId,
    forwarder: read.forwarder,
    mandate: read.mandate,
    amount: read.amount,
    status: 'awaiting_signature',
    txHash: null,
    failureReason: null,
    funding: null,
    promptedAt: null,
  });
  if (row.principalId !== principalId || row.projectId !== projectId) {
    throw new SweepTenantError();
  }
  if (row.status !== 'awaiting_signature' || row.promptedAt !== null) return row;
  await ports.prompts.requestSignature(
    {
      scope: read.scope,
      network: read.network,
      depositOperationId: read.depositOperationId,
      forwarder: row.forwarder,
      mandate: row.mandate,
      amount: row.amount,
    },
    promptKey(row),
  );
  const at = nowSeconds();
  await ports.store.markPrompted(read, at);
  return { ...row, promptedAt: at };
}

function keyOf(read: SweepKey): SweepKey {
  return {
    scope: read.scope,
    network: read.network,
    depositOperationId: read.depositOperationId,
  };
}

async function requireSweep(key: SweepKey, store: SweepStore): Promise<SweepRecord> {
  const row = await store.get(key);
  if (row === null) throw new SweepStateError();
  return row;
}

/**
 * Sends the principal's signed sweep. The hash is written first, so nothing
 * goes out unrecorded. Asked again for the same payload it sends nothing and
 * returns the row; a different payload, or a sweep that already failed, throws
 * SweepStateError. A send that definitely did not land marks the sweep failed.
 * Anything else leaves it submitted for reconcileSweep, since it may have.
 */
export async function submitSweep(
  request: SweepKey & { readonly signedPayload: string },
  ports: SweepPorts,
  options: SweepOptions,
): Promise<SweepRecord> {
  const read = parsed(submitSchema, request, 'request');
  const { timeoutMs } = parsed(optionsSchema, options, 'options');
  const key = keyOf(read);
  const row = await requireSweep(key, ports.store);
  const txHash = ports.chain.hashOf(read.signedPayload);
  if (row.status !== 'awaiting_signature') {
    if (row.status !== 'failed' && row.txHash === txHash) return row;
    throw new SweepStateError();
  }
  const submitted = await ports.store.transition(key, 'awaiting_signature', {
    status: 'submitted',
    txHash,
  });
  try {
    await withDeadline(timeoutMs, (signal) => ports.chain.submit(read.signedPayload, signal));
  } catch (err) {
    if (isChainAdapterError(err) && err.landed === 'no') {
      await failSweep(key, submitted, 'rejected', ports);
    }
    throw err;
  }
  return submitted;
}

async function failSweep(
  key: SweepKey,
  row: SweepRecord,
  reason: SweepFailureReason,
  ports: SweepPorts,
): Promise<SweepRecord> {
  const failed = await ports.store.transition(key, 'submitted', {
    status: 'failed',
    failureReason: reason,
  });
  ports.reports.sweepFailed({
    principalId: row.principalId,
    projectId: row.projectId,
    network: row.network,
    depositOperationId: row.depositOperationId,
    reason,
  });
  return failed;
}

function fundingTransfer(
  row: SweepRecord,
  token: string,
  transfers: readonly SweepTransferEvent[],
): SweepTransferEvent | undefined {
  return transfers.find(
    (t) =>
      t.token === token &&
      t.from === row.forwarder &&
      t.to === row.mandate &&
      equals(t.amount, row.amount),
  );
}

/**
 * Brings a submitted sweep up to date with the chain. It confirms only on an
 * asset contract transfer of this amount from the forwarding account to the
 * mandate, and the record references that event. A duplicate on-chain sweep
 * fails for insufficient balance, which cannot double fund: it is marked
 * failed and reported, never retried. Any other sweep comes back unchanged.
 */
export async function reconcileSweep(
  request: SweepKey,
  ports: SweepPorts,
  options: SweepOptions,
): Promise<SweepRecord> {
  const key = keyOf(parsed(keySchema, request, 'request'));
  const { timeoutMs, token } = parsed(optionsSchema, options, 'options');
  const row = await requireSweep(key, ports.store);
  const { txHash } = row;
  if (row.status !== 'submitted' || txHash === null) return row;
  const result = await withDeadline(timeoutMs, (signal) => ports.chain.result(txHash, signal));
  if (result.kind === 'pending') return row;
  if (result.kind === 'failed') return failSweep(key, row, result.reason, ports);
  const transfer = fundingTransfer(row, token, result.transfers);
  if (transfer === undefined) return failSweep(key, row, 'no_matching_transfer', ports);
  return ports.store.transition(key, 'submitted', {
    status: 'confirmed',
    funding: { txHash, eventIndex: transfer.eventIndex, to: transfer.to },
  });
}
