// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Moves each deposit on a forwarding account into the mandate, exactly once.
// A double sweep moves money, and the funding_sweeps table can only hold a
// caller to what it says. It has to believe the time bound is the real one, the
// ledger really recorded the failure, submitted was written before sending and
// an expired transaction did not land first. Those are this module's duties:
//
// - The hash and time bounds come from the signed envelope itself, and are
//   written as submitted before anything is sent. Sending is a later job step,
//   which looks the hash up first, so a crash after a send sends nothing new.
// - A sweep fails only on a ledger read from a transaction result, or once the
//   network has no record of it and its time bound is past by the margin.
//   Whatever the clock says, a hash that landed is followed.
// - A failure rolls back without using the authorization entry's nonce, so the
//   signed entry stays usable until its own expiry. A new signature is asked
//   for only after that, or two could be live.
// - A sweep that failed for insufficient balance found the money gone, so it
//   is reported and never goes round again, though the table would allow it.
//
// This package knows no chain. What is sent and how it is built is the chain
// adapter's, behind the SweepChain port.

import { chainOf, isNetworkId } from '@ujira/chain-adapter';
import type { NetworkId } from '@ujira/chain-adapter';
import { equals, isNegative, isZero } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';
import type { FundingSweep, FundingSweepMove, NewFundingSweep } from '@ujira/db';
import { z } from 'zod';

import {
  FundingInputError,
  SweepStateError,
  SweepTenantError,
  SweepTimeoutError,
} from './errors.js';

/**
 * How long past its time bound a transaction may be claimed dead with no ledger
 * to show for it. The table holds the same five minutes: they cover the gap
 * between our clock and the network's.
 */
export const FAILED_EXPIRY_MARGIN_MS = 300_000;

export interface SweepScope {
  readonly principalId: string;
  readonly projectId: string;
}

export interface SweepKey {
  readonly scope: SweepScope;
  readonly network: NetworkId;
  readonly depositOperationId: string;
}

/** Where a sweep moves money, from the funding source and mandate instance it names. */
export interface SweepRoute {
  readonly forwarder: string;
  readonly mandate: string;
  /** The asset contract a transfer must come from. */
  readonly token: string;
}

/**
 * The funding_sweeps repository, under the tenant's transaction. Only this
 * tenant's rows are visible. `create` answers 'duplicate' when the chain and
 * operation already exist, in any tenant. `setStatus` is false when this tenant
 * has no such row, and throws SweepStateError for a move the table refuses.
 */
export interface SweepStore {
  byDepositOperation(
    scope: SweepScope,
    input: { readonly chain: string; readonly depositOperationId: string },
  ): Promise<FundingSweep | undefined>;
  create(scope: SweepScope, input: NewFundingSweep): Promise<FundingSweep | 'duplicate'>;
  setStatus(scope: SweepScope, id: string, move: FundingSweepMove): Promise<boolean>;
}

export interface SweepPrompt {
  readonly scope: SweepScope;
  readonly network: NetworkId;
  readonly depositOperationId: string;
  readonly route: SweepRoute;
  readonly amount: TokenAmount;
}

/**
 * Queues the principal's prompt in the outbox. The key makes a repeat a no-op
 * there, which is what makes one prompt per attempt hold across a crash.
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

/** What the network says of a hash. `failed` and `landed` name the ledger that applied it. */
export type SweepChainResult =
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'landed';
      readonly ledger: number;
      readonly transfers: readonly SweepTransferEvent[];
    }
  | {
      readonly kind: 'failed';
      readonly ledger: number;
      readonly reason: 'insufficient_balance' | 'rejected';
    };

/** What a signed envelope itself says, so nothing about it is taken on trust. */
export interface SweepEnvelope {
  /** Hex. */
  readonly txHash: string;
  /** The last moment it can be applied, from its time bounds. */
  readonly validUntil: Date;
  /** The ledger its signed authorization entry expires at, or null when it has none. */
  readonly authExpiresLedger: number | null;
}

/** The chain adapter's side. */
export interface SweepChain {
  /** Throws for an envelope with no upper time bound. */
  describe(signedPayload: string): SweepEnvelope;
  send(signedPayload: string, signal: AbortSignal): Promise<void>;
  result(txHash: string, signal: AbortSignal): Promise<SweepChainResult>;
  latestLedger(signal: AbortSignal): Promise<number>;
}

export type SweepFailureReason =
  'insufficient_balance' | 'rejected' | 'no_matching_transfer' | 'expired';

export type SweepAlertKind = 'landed_after_failed' | 'unexplained';

/** What a person should look at. */
export interface SweepReports {
  sweepFailed(event: {
    readonly principalId: string;
    readonly projectId: string;
    readonly network: NetworkId;
    readonly depositOperationId: string;
    readonly reason: SweepFailureReason;
  }): void;
  /** A transfer landed that no live attempt explains. A double sweep looks like this. */
  transferAlert(event: {
    readonly principalId: string;
    readonly projectId: string;
    readonly network: NetworkId;
    readonly txHash: string;
    readonly kind: SweepAlertKind;
  }): void;
}

/** What funded the mandate. Idempotent on `key`, since it is written before the row moves. */
export interface SweepFundingRecord {
  readonly scope: SweepScope;
  readonly network: NetworkId;
  readonly depositOperationId: string;
  readonly mandateInstanceId: string;
  /** Hex. */
  readonly txHash: string;
  readonly eventIndex: number;
  /** The mandate. */
  readonly to: string;
  readonly amount: TokenAmount;
}

export interface SweepFunding {
  record(record: SweepFundingRecord, key: string): Promise<void>;
}

export interface SweepPorts {
  readonly store: SweepStore;
  readonly prompts: SweepPrompts;
  readonly chain: SweepChain;
  readonly reports: SweepReports;
  readonly funding: SweepFunding;
  readonly clock: { now(): Date };
}

export interface SweepOptions {
  /** How long to wait for the chain, in whole milliseconds. */
  readonly timeoutMs: number;
}

export interface DepositEvent extends SweepKey {
  readonly fundingSourceId: string;
  readonly mandateInstanceId: string;
  readonly route: SweepRoute;
  readonly amount: TokenAmount;
}

export type SweepRetry =
  | { readonly kind: 'retried'; readonly sweep: FundingSweep }
  /** Run the step again once the network reaches this ledger. */
  | { readonly kind: 'waiting'; readonly untilLedger: number }
  | { readonly kind: 'declined'; readonly reason: 'insufficient_balance' | 'landed' };

export interface ObservedTransfer {
  readonly scope: SweepScope;
  readonly network: NetworkId;
  /** Hex. */
  readonly txHash: string;
  readonly eventIndex: number;
  readonly from: string;
  readonly to: string;
  readonly amount: TokenAmount;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Operation ids are decimal integers on the chains UJIRA settles on.
const OPERATION_ID = /^[0-9]{1,32}$/;
const MAX_TIMEOUT_MS = 120_000;
const MAX_ISSUES = 10;

const uuid = z.string().regex(UUID);
const address = z.string().min(1).max(128);

const keyFields = {
  scope: z.strictObject({ principalId: uuid, projectId: uuid }),
  network: z.custom<NetworkId>(isNetworkId),
  depositOperationId: z.string().regex(OPERATION_ID),
};

const routeSchema = z.strictObject({ forwarder: address, mandate: address, token: address });

const depositSchema = z.strictObject({
  ...keyFields,
  fundingSourceId: uuid,
  mandateInstanceId: uuid,
  route: routeSchema,
  amount: z.custom<TokenAmount>(isPositiveToken),
});

const keySchema = z.strictObject(keyFields);
const signedSchema = z.strictObject({
  ...keyFields,
  signedPayload: z.string().min(1).max(350_000),
});
const reconcileSchema = z.strictObject({ ...keyFields, route: routeSchema });
const retrySchema = z.strictObject({
  ...keyFields,
  route: routeSchema,
  authExpiresLedger: z.int().min(0).nullable(),
});
const optionsSchema = z.strictObject({ timeoutMs: z.int().min(1).max(MAX_TIMEOUT_MS) });

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

export function parsed<T>(schema: z.ZodType<T>, value: unknown, root: string): T {
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
  options: SweepOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SweepTimeoutError());
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function hexOf(hash: Buffer): string {
  return hash.toString('hex');
}

function operationOf(key: SweepKey): {
  readonly chain: string;
  readonly depositOperationId: string;
} {
  return { chain: chainOf(key.network), depositOperationId: key.depositOperationId };
}

function find(key: SweepKey, store: SweepStore): Promise<FundingSweep | undefined> {
  return store.byDepositOperation(key.scope, operationOf(key));
}

async function requireSweep(key: SweepKey, store: SweepStore): Promise<FundingSweep> {
  const row = await find(key, store);
  if (row === undefined) throw new SweepStateError();
  return row;
}

async function moved(
  key: SweepKey,
  row: FundingSweep,
  move: FundingSweepMove,
  store: SweepStore,
): Promise<FundingSweep> {
  if (!(await store.setStatus(key.scope, row.id, move))) throw new SweepStateError();
  return requireSweep(key, store);
}

function firstPromptKey(key: SweepKey): string {
  return `sweep:${chainOf(key.network)}:${key.depositOperationId}`;
}

/**
 * Records a deposit and prompts the principal once. Safe to call for every
 * sighting of the same deposit. It trusts the tenant the event names, so whoever
 * attributes deposits must have checked that the forwarding account and mandate
 * are that tenant's. Throws SweepTenantError when the operation is already
 * recorded under another tenant.
 */
export async function recordDeposit(event: DepositEvent, ports: SweepPorts): Promise<FundingSweep> {
  const read = parsed(depositSchema, event, 'deposit');
  const row = (await find(read, ports.store)) ?? (await createSweep(read, ports.store));
  if (row.status === 'awaiting_signature') {
    await ports.prompts.requestSignature(
      {
        scope: read.scope,
        network: read.network,
        depositOperationId: read.depositOperationId,
        route: read.route,
        amount: row.amount,
      },
      firstPromptKey(read),
    );
  }
  return row;
}

async function createSweep(
  read: z.infer<typeof depositSchema>,
  store: SweepStore,
): Promise<FundingSweep> {
  const created = await store.create(read.scope, {
    fundingSourceId: read.fundingSourceId,
    mandateInstanceId: read.mandateInstanceId,
    depositOperationId: read.depositOperationId,
    amount: read.amount,
  });
  if (created !== 'duplicate') return created;
  // The key is global and the row is not visible unless it is ours, so a clash
  // is either a racing attempt of this tenant's or another tenant's deposit.
  const raced = await find(read, store);
  if (raced === undefined) throw new SweepTenantError();
  return raced;
}

/**
 * Takes the principal's signed sweep and writes it as submitted, with the hash
 * and time bounds read from the envelope itself. Nothing is sent here: the
 * caller queues sendSweep, so nothing can leave before the row names it. The same
 * payload again changes nothing. A different one throws SweepStateError, as does
 * a sweep in any other state, or an envelope whose time bound has passed.
 */
export async function acceptSweepSignature(
  request: SweepKey & { readonly signedPayload: string },
  ports: SweepPorts,
): Promise<FundingSweep> {
  const read = parsed(signedSchema, request, 'request');
  const row = await requireSweep(read, ports.store);
  const envelope = ports.chain.describe(read.signedPayload);
  if (row.status === 'submitted' && row.sweepTxHash !== null) {
    if (hexOf(row.sweepTxHash) === envelope.txHash) return row;
    throw new SweepStateError();
  }
  if (row.status !== 'awaiting_signature') throw new SweepStateError();
  return moved(
    read,
    row,
    {
      status: 'submitted',
      sweepTxHash: Buffer.from(envelope.txHash, 'hex'),
      validUntil: envelope.validUntil,
    },
    ports.store,
  );
}

/**
 * Sends a submitted sweep's envelope. The queue's step, so it may run again
 * after a crash at any point: it looks the hash up first and sends only if the
 * network has never seen it, which can only ever be this same envelope. A failed
 * send leaves the sweep submitted, because only a ledger or the passing of its
 * time bound can show it will not land. reconcileSweep ends it.
 */
export async function sendSweep(
  request: SweepKey & { readonly signedPayload: string },
  ports: SweepPorts,
  options: SweepOptions,
): Promise<'sent' | 'already_on_network'> {
  const read = parsed(signedSchema, request, 'request');
  const limits = parsed(optionsSchema, options, 'options');
  const row = await requireSweep(read, ports.store);
  const { txHash } = ports.chain.describe(read.signedPayload);
  if (row.status !== 'submitted' || row.sweepTxHash === null || hexOf(row.sweepTxHash) !== txHash) {
    throw new SweepStateError();
  }
  const seen = await withDeadline(limits, (signal) => ports.chain.result(txHash, signal));
  if (seen.kind !== 'not_found') return 'already_on_network';
  await withDeadline(limits, (signal) => ports.chain.send(read.signedPayload, signal));
  return 'sent';
}

async function failSweep(
  key: SweepKey,
  row: FundingSweep,
  failedLedger: bigint | null,
  reason: SweepFailureReason,
  ports: SweepPorts,
): Promise<FundingSweep> {
  const failed = await moved(key, row, { status: 'failed', failedLedger }, ports.store);
  ports.reports.sweepFailed({
    principalId: key.scope.principalId,
    projectId: key.scope.projectId,
    network: key.network,
    depositOperationId: key.depositOperationId,
    reason,
  });
  return failed;
}

/**
 * Brings a submitted sweep up to date with the network, and returns any other
 * sweep as it is. It settles only on an asset contract transfer of this amount
 * from the forwarding account to the mandate. It fails with the ledger it read
 * from the result, or, when the network has no record, only once the time bound
 * is past by the margin. A hash that landed is followed whatever the clock says.
 */
export async function reconcileSweep(
  request: SweepKey & { readonly route: SweepRoute },
  ports: SweepPorts,
  options: SweepOptions,
): Promise<FundingSweep> {
  const read = parsed(reconcileSchema, request, 'request');
  const limits = parsed(optionsSchema, options, 'options');
  const row = await requireSweep(read, ports.store);
  if (row.status !== 'submitted' || row.sweepTxHash === null || row.validUntil === null) return row;
  const txHash = hexOf(row.sweepTxHash);
  const result = await withDeadline(limits, (signal) => ports.chain.result(txHash, signal));
  if (result.kind === 'not_found') {
    const deadline = row.validUntil.getTime() + FAILED_EXPIRY_MARGIN_MS;
    if (ports.clock.now().getTime() < deadline) return row;
    return failSweep(read, row, null, 'expired', ports);
  }
  const ledger = BigInt(result.ledger);
  if (result.kind === 'failed') return failSweep(read, row, ledger, result.reason, ports);
  const { forwarder, mandate, token } = read.route;
  const transfer = result.transfers.find(
    (t) =>
      t.token === token && t.from === forwarder && t.to === mandate && equals(t.amount, row.amount),
  );
  if (transfer === undefined) return failSweep(read, row, ledger, 'no_matching_transfer', ports);
  // Before the row moves, so a crash between the two repeats this and the key
  // drops the repeat, rather than leaving a settled sweep with no funding record.
  await ports.funding.record(
    {
      scope: read.scope,
      network: read.network,
      depositOperationId: read.depositOperationId,
      mandateInstanceId: row.mandateInstanceId,
      txHash,
      eventIndex: transfer.eventIndex,
      to: transfer.to,
      amount: row.amount,
    },
    `sweep-funding:${chainOf(read.network)}:${read.depositOperationId}`,
  );
  return moved(read, row, { status: 'settled' }, ports.store);
}

/**
 * Takes a failed sweep round again, through the table's typed move, once that
 * cannot put two live signatures or two transfers on the network. It reads the
 * hash again, because the row cannot say why it failed: insufficient balance
 * means the money has gone, and a hash that landed means it should never have
 * been failed, which also raises an alert. Both are declined, not thrown, so the
 * queue does not retry them. While the earlier entry can still authorize a
 * transfer it answers waiting. `authExpiresLedger` comes from the envelope
 * accepted for this attempt, null when it carried no signed entry.
 */
export async function retrySweep(
  request: SweepKey & { readonly route: SweepRoute; readonly authExpiresLedger: number | null },
  ports: SweepPorts,
  options: SweepOptions,
): Promise<SweepRetry> {
  const read = parsed(retrySchema, request, 'request');
  const limits = parsed(optionsSchema, options, 'options');
  const row = await requireSweep(read, ports.store);
  // Asked again after the move, when the prompt is already queued.
  if (row.status === 'awaiting_signature') return { kind: 'retried', sweep: row };
  if (row.status !== 'failed' || row.sweepTxHash === null) throw new SweepStateError();
  const txHash = hexOf(row.sweepTxHash);
  const result = await withDeadline(limits, (signal) => ports.chain.result(txHash, signal));
  if (result.kind === 'landed') {
    ports.reports.transferAlert({
      principalId: read.scope.principalId,
      projectId: read.scope.projectId,
      network: read.network,
      txHash,
      kind: 'landed_after_failed',
    });
    return { kind: 'declined', reason: 'landed' };
  }
  if (result.kind === 'failed' && result.reason === 'insufficient_balance') {
    return { kind: 'declined', reason: 'insufficient_balance' };
  }
  if (read.authExpiresLedger !== null) {
    const expires = read.authExpiresLedger;
    const latest = await withDeadline(limits, (signal) => ports.chain.latestLedger(signal));
    // The entry is still good in the ledger it names.
    if (latest <= expires) return { kind: 'waiting', untilLedger: expires + 1 };
  }
  // Queued before the row gives up the old hash, which is what keeps the key the
  // same if this step runs again after a crash. The outbox then drops the repeat.
  await ports.prompts.requestSignature(
    {
      scope: read.scope,
      network: read.network,
      depositOperationId: read.depositOperationId,
      route: read.route,
      amount: row.amount,
    },
    `${firstPromptKey(read)}:after:${txHash}`,
  );
  return {
    kind: 'retried',
    sweep: await moved(read, row, { status: 'awaiting_signature' }, ports.store),
  };
}

/** The principal's decision, final. A sweep already sent cannot be cancelled. */
export async function cancelSweep(request: SweepKey, ports: SweepPorts): Promise<FundingSweep> {
  const read = parsed(keySchema, request, 'request');
  const row = await requireSweep(read, ports.store);
  return moved(read, row, { status: 'cancelled' }, ports.store);
}

/**
 * Classifies a transfer the indexer saw from a forwarding account to its mandate,
 * against that source's rows. A retry drops the old hash and a cancelled row
 * never held one, so a transfer from an abandoned attempt matches nothing: any
 * hash no live row names is unexplained and raises an alert. The principal owns
 * the account and can also send from their own wallet, so an alert is for a
 * person to look at, not a fault. Naming the exact attempt would need a record of
 * past hashes, which the table does not keep.
 */
export function noteObservedTransfer(
  transfer: ObservedTransfer,
  rows: readonly FundingSweep[],
  reports: SweepReports,
): 'expected' | SweepAlertKind {
  const row = rows.find((r) => r.sweepTxHash !== null && hexOf(r.sweepTxHash) === transfer.txHash);
  if (row?.status === 'submitted' || row?.status === 'settled') return 'expected';
  const kind: SweepAlertKind = row === undefined ? 'unexplained' : 'landed_after_failed';
  reports.transferAlert({
    principalId: transfer.scope.principalId,
    projectId: transfer.scope.projectId,
    network: transfer.network,
    txHash: transfer.txHash,
    kind,
  });
  return kind;
}
