// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the chain adapter keeps: submissions, deliveries, sponsorship reservations and
// signing requests. As everywhere, no method takes a tenant id. The adapter's port is
// DatabaseAdapterStore, built on these, and this file knows nothing about any chain.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;
type Json = Readonly<Record<string, unknown>>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface NewChainSubmission {
  readonly network: string;
  readonly txHash: string;
  readonly op: string;
  readonly mandate: string | null;
  readonly payoutId: string | null;
  readonly attempt: number | null;
  readonly signerAddress: string;
  readonly sequenceOrNonce: bigint;
  readonly maxTime: Date | null;
  readonly replacesTxHash: string | null;
  readonly submittedAtLedger: bigint | null;
  readonly reservationId: string | null;
  readonly correlationId: string;
  readonly createdAt: Date;
}

export interface ChainSubmission extends NewChainSubmission {
  readonly id: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly state: string;
  readonly landedAtHeight: bigint | null;
  readonly errorCode: string | null;
  readonly specCode: number | null;
  readonly updatedAt: Date;
}

export interface ChainSubmissionPatch {
  readonly state?: string;
  readonly landedAtHeight?: bigint | null;
  readonly errorCode?: string | null;
  readonly specCode?: number | null;
}

const submissionColumns = [
  'id',
  'principal_id',
  'project_id',
  'network',
  'tx_hash',
  'op',
  'mandate',
  'payout_id',
  'attempt',
  'signer_address',
  'sequence_or_nonce',
  'max_time',
  'state',
  'landed_at_height',
  'error_code',
  'spec_code',
  'replaces_tx_hash',
  'submitted_at_ledger',
  'reservation_id',
  'correlation_id',
  'created_at',
  'updated_at',
] as const;

interface SubmissionRow {
  id: string;
  principal_id: string;
  project_id: string;
  network: string;
  tx_hash: string;
  op: string;
  mandate: string | null;
  payout_id: string | null;
  attempt: string | null;
  signer_address: string;
  sequence_or_nonce: string;
  max_time: Date | null;
  state: string;
  landed_at_height: string | null;
  error_code: string | null;
  spec_code: string | null;
  replaces_tx_hash: string | null;
  submitted_at_ledger: string | null;
  reservation_id: string | null;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
}

function bigOrNull(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function toSubmission(row: SubmissionRow): ChainSubmission {
  return {
    id: row.id,
    principalId: row.principal_id,
    projectId: row.project_id,
    network: row.network,
    txHash: row.tx_hash,
    op: row.op,
    mandate: row.mandate,
    payoutId: row.payout_id,
    // Checked to a range well inside a double, so this is exact.
    attempt: row.attempt === null ? null : Number(row.attempt),
    signerAddress: row.signer_address,
    sequenceOrNonce: BigInt(row.sequence_or_nonce),
    maxTime: row.max_time,
    state: row.state,
    landedAtHeight: bigOrNull(row.landed_at_height),
    errorCode: row.error_code,
    // A contract's own error code, which is a small number.
    specCode: row.spec_code === null ? null : Number(row.spec_code),
    replacesTxHash: row.replaces_tx_hash,
    submittedAtLedger: bigOrNull(row.submitted_at_ledger),
    reservationId: row.reservation_id,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const chainSubmissions = {
  // Written before broadcast. A second row for a hash, or a second live one for a step,
  // is refused by the database (23505), and a row that is not built with UJ004.
  record: async (db: Tx, input: NewChainSubmission): Promise<ChainSubmission> => {
    const row = await db
      .insertInto('ujira.chain_submissions')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        network: input.network,
        tx_hash: input.txHash,
        op: input.op,
        mandate: input.mandate,
        payout_id: input.payoutId,
        attempt: input.attempt,
        signer_address: input.signerAddress,
        sequence_or_nonce: input.sequenceOrNonce.toString(),
        max_time: input.maxTime,
        replaces_tx_hash: input.replacesTxHash,
        submitted_at_ledger: input.submittedAtLedger,
        reservation_id: input.reservationId,
        correlation_id: input.correlationId,
        created_at: input.createdAt,
      })
      .returning(submissionColumns)
      .executeTakeFirstOrThrow();
    return toSubmission(row);
  },

  // Undefined when this tenant has no such submission. A state the machine does not
  // allow is refused by the database with UJ004.
  update: async (
    db: Tx,
    network: string,
    txHash: string,
    patch: ChainSubmissionPatch,
  ): Promise<ChainSubmission | undefined> => {
    const values = {
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.landedAtHeight === undefined ? {} : { landed_at_height: patch.landedAtHeight }),
      ...(patch.errorCode === undefined ? {} : { error_code: patch.errorCode }),
      ...(patch.specCode === undefined ? {} : { spec_code: patch.specCode }),
    };
    if (Object.keys(values).length === 0) return chainSubmissions.find(db, network, txHash);
    const row = await db
      .updateTable('ujira.chain_submissions')
      .set(values)
      .where('network', '=', network)
      .where('tx_hash', '=', txHash)
      .returning(submissionColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toSubmission(row);
  },

  find: async (db: Tx, network: string, txHash: string): Promise<ChainSubmission | undefined> => {
    const row = await db
      .selectFrom('ujira.chain_submissions')
      .select(submissionColumns)
      .where('network', '=', network)
      .where('tx_hash', '=', txHash)
      .executeTakeFirst();
    return row === undefined ? undefined : toSubmission(row);
  },

  live: async (
    db: Tx,
    key: {
      readonly network: string;
      readonly mandate: string;
      readonly payoutId: string;
      readonly op: string;
    },
  ): Promise<ChainSubmission | undefined> => {
    const row = await db
      .selectFrom('ujira.chain_submissions')
      .select(submissionColumns)
      .where('network', '=', key.network)
      .where('mandate', '=', key.mandate)
      .where('payout_id', '=', key.payoutId)
      .where('op', '=', key.op)
      .where('state', 'in', ['built', 'broadcast', 'unknown'])
      .executeTakeFirst();
    return row === undefined ? undefined : toSubmission(row);
  },

  // The landed submission that executed this payout on its own.
  landed: async (
    db: Tx,
    key: { readonly network: string; readonly mandate: string; readonly payoutId: string },
  ): Promise<ChainSubmission | undefined> => {
    const row = await db
      .selectFrom('ujira.chain_submissions')
      .select(submissionColumns)
      .where('network', '=', key.network)
      .where('mandate', '=', key.mandate)
      .where('payout_id', '=', key.payoutId)
      .where('op', '=', 'execute')
      .where('state', '=', 'landed')
      .executeTakeFirst();
    return row === undefined ? undefined : toSubmission(row);
  },

  // Every state move of one submission, the first recording included.
  events: async (
    db: Tx,
    submissionId: string,
  ): Promise<readonly { readonly from: string | null; readonly to: string }[]> => {
    const rows = await db
      .selectFrom('ujira.chain_submission_events')
      .select(['from_state', 'to_state'])
      .where('submission_id', '=', submissionId)
      .orderBy('seq')
      .execute();
    return rows.map((row) => ({ from: row.from_state, to: row.to_state }));
  },
};

// Platform work, across every tenant on purpose, called inside db.unscoped().
export const chainSubmissionSweep = {
  unresolved: async (
    db: Tx,
    input: { readonly network: string; readonly before: Date; readonly limit: number },
  ): Promise<readonly ChainSubmission[]> => {
    const result = await sql<SubmissionRow>`
      select * from ujira.unresolved_chain_submissions(
        ${input.network}, ${input.before}::timestamptz, ${input.limit}
      )
    `.execute(db);
    return result.rows.map(toSubmission);
  },
};

export interface LegDelivery {
  readonly legKey: string;
  readonly network: string;
  readonly rail: string;
  readonly provider: string;
  readonly providerRef: string | null;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly quoteId: string | null;
  readonly state: string;
  readonly rawStatus: string | null;
  readonly live: boolean;
  readonly expiresAt: Date | null;
  readonly updatedAt: Date;
}

const deliveryColumns = [
  'leg_key',
  'network',
  'rail',
  'provider',
  'provider_ref',
  'destination_address',
  'destination_tag',
  'quote_id',
  'state',
  'raw_status',
  'live',
  'expires_at',
  'updated_at',
] as const;

function toDelivery(row: {
  leg_key: string;
  network: string;
  rail: string;
  provider: string;
  provider_ref: string | null;
  destination_address: string;
  destination_tag: string | null;
  quote_id: string | null;
  state: string;
  raw_status: string | null;
  live: boolean;
  expires_at: Date | null;
  updated_at: Date;
}): LegDelivery {
  return {
    legKey: row.leg_key,
    network: row.network,
    rail: row.rail,
    provider: row.provider,
    providerRef: row.provider_ref,
    destinationAddress: row.destination_address,
    destinationTag: bigOrNull(row.destination_tag),
    quoteId: row.quote_id,
    state: row.state,
    rawStatus: row.raw_status,
    live: row.live,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export const legDeliveries = {
  // Upsert on leg key, provider and reference. False when that row is another tenant's:
  // the key is unique across tenants, so nothing was written and the caller must refuse.
  // A second live record for a leg key and provider is refused by the database (23505).
  upsert: async (db: Tx, input: LegDelivery): Promise<boolean> => {
    const mutable = {
      state: input.state,
      raw_status: input.rawStatus,
      raw_status_at: input.rawStatus === null ? null : input.updatedAt,
      live: input.live,
      expires_at: input.expiresAt,
      quote_id: input.quoteId,
      updated_at: input.updatedAt,
    };
    const inserted = await db
      .insertInto('ujira.leg_deliveries')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        leg_key: input.legKey,
        network: input.network,
        rail: input.rail,
        provider: input.provider,
        provider_ref: input.providerRef,
        destination_address: input.destinationAddress,
        destination_tag: input.destinationTag?.toString() ?? null,
        ...mutable,
      })
      .onConflict((conflict) => conflict.constraint('leg_deliveries_once').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted !== undefined) return true;
    const updated = await db
      .updateTable('ujira.leg_deliveries')
      .set(mutable)
      .where('leg_key', '=', input.legKey)
      .where('provider', '=', input.provider)
      .where(sql<boolean>`provider_ref is not distinct from ${input.providerRef}`)
      .executeTakeFirst();
    return updated.numUpdatedRows > 0n;
  },

  // Several providers can each hold a live record. The latest is current.
  live: async (db: Tx, legKey: string): Promise<LegDelivery | undefined> => {
    const row = await db
      .selectFrom('ujira.leg_deliveries')
      .select(deliveryColumns)
      .where('leg_key', '=', legKey)
      .where('live', '=', true)
      .orderBy('updated_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toDelivery(row);
  },
};

export interface NewSponsorship {
  readonly reservationId: string;
  readonly network: string;
  readonly intent: string;
  readonly nativeAsset: string;
  readonly scale: number;
  readonly maxFee: bigint;
}

export interface Sponsorship extends NewSponsorship {
  readonly state: string;
  readonly actualFee: bigint | null;
}

const sponsorshipColumns = [
  'reservation_id',
  'network',
  'intent',
  'native_asset',
  'scale',
  'max_fee_native',
  'actual_fee_native',
  'state',
] as const;

function toSponsorship(row: {
  reservation_id: string;
  network: string;
  intent: string;
  native_asset: string;
  scale: number;
  max_fee_native: string;
  actual_fee_native: string | null;
  state: string;
}): Sponsorship {
  return {
    reservationId: row.reservation_id,
    network: row.network,
    intent: row.intent,
    nativeAsset: row.native_asset,
    scale: row.scale,
    maxFee: BigInt(row.max_fee_native),
    actualFee: bigOrNull(row.actual_fee_native),
    state: row.state,
  };
}

export const sponsorshipLedger = {
  // Idempotent per reservation: a retry finds the first with created false.
  reserve: async (
    db: Tx,
    input: NewSponsorship,
  ): Promise<{ readonly created: boolean; readonly sponsorship: Sponsorship }> => {
    const inserted = await db
      .insertInto('ujira.sponsorship_ledger')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        reservation_id: input.reservationId,
        network: input.network,
        intent: input.intent,
        native_asset: input.nativeAsset,
        scale: input.scale,
        max_fee_native: input.maxFee.toString(),
      })
      .onConflict((conflict) => conflict.constraint('sponsorship_ledger_once').doNothing())
      .returning(sponsorshipColumns)
      .executeTakeFirst();
    if (inserted !== undefined) return { created: true, sponsorship: toSponsorship(inserted) };
    const existing = await db
      .selectFrom('ujira.sponsorship_ledger')
      .select(sponsorshipColumns)
      .where('reservation_id', '=', input.reservationId)
      .executeTakeFirstOrThrow();
    return { created: false, sponsorship: toSponsorship(existing) };
  },

  get: async (db: Tx, reservationId: string): Promise<Sponsorship | undefined> => {
    const row = await db
      .selectFrom('ujira.sponsorship_ledger')
      .select(sponsorshipColumns)
      .where('reservation_id', '=', reservationId)
      .executeTakeFirst();
    return row === undefined ? undefined : toSponsorship(row);
  },

  // Each moves only from reserved. Undefined when this tenant has no reservation still
  // open under that id.
  settle: async (
    db: Tx,
    reservationId: string,
    actualFee: bigint,
  ): Promise<Sponsorship | undefined> => {
    const row = await db
      .updateTable('ujira.sponsorship_ledger')
      .set({ state: 'settled', actual_fee_native: actualFee.toString() })
      .where('reservation_id', '=', reservationId)
      .where('state', '=', 'reserved')
      .returning(sponsorshipColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toSponsorship(row);
  },

  release: async (db: Tx, reservationId: string): Promise<Sponsorship | undefined> => {
    const row = await db
      .updateTable('ujira.sponsorship_ledger')
      .set({ state: 'released' })
      .where('reservation_id', '=', reservationId)
      .where('state', '=', 'reserved')
      .returning(sponsorshipColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toSponsorship(row);
  },
};

export interface NewSigningRequest {
  readonly requestId: string;
  readonly network: string;
  readonly signer: string;
  readonly request: Json;
  readonly validUntil: Date;
}

export interface StoredSigningRequest extends NewSigningRequest {
  readonly consumedAt: Date | null;
}

const signingColumns = [
  'request_id',
  'network',
  'signer',
  'request',
  'valid_until',
  'consumed_at',
] as const;

function toSigning(row: {
  request_id: string;
  network: string;
  signer: string;
  request: unknown;
  valid_until: Date;
  consumed_at: Date | null;
}): StoredSigningRequest {
  return {
    requestId: row.request_id,
    network: row.network,
    signer: row.signer,
    request: row.request as Json,
    validUntil: row.valid_until,
    consumedAt: row.consumed_at,
  };
}

export const signingRequests = {
  // Refused by the database (23505) when this tenant already has this request id.
  record: async (db: Tx, input: NewSigningRequest): Promise<void> => {
    await db
      .insertInto('ujira.signing_requests')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        request_id: input.requestId,
        network: input.network,
        signer: input.signer,
        // Sent as JSON text: pg would send an array as a Postgres array.
        request: JSON.stringify(input.request),
        valid_until: input.validUntil,
      })
      .execute();
  },

  get: async (db: Tx, requestId: string): Promise<StoredSigningRequest | undefined> => {
    const row = await db
      .selectFrom('ujira.signing_requests')
      .select(signingColumns)
      .where('request_id', '=', requestId)
      .executeTakeFirst();
    return row === undefined ? undefined : toSigning(row);
  },

  // True for the one caller that consumed it, however many race, so a signed request is
  // submitted once.
  consume: async (db: Tx, requestId: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.signing_requests')
      .set({ consumed_at: sql<Date>`now()` })
      .where('request_id', '=', requestId)
      .where('consumed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

// Run by the retention login, which holds execute on these two functions and nothing
// else here. Each clears at most the limit and returns how many, so a job runs it until
// it returns 0.
export const chainRetention = {
  clearDeliveryStatus: async (db: Tx, limit: number): Promise<bigint> => {
    const result = await sql<{ cleared: string }>`
      select ujira.clear_stale_delivery_status(${limit}) as cleared
    `.execute(db);
    return BigInt(result.rows[0]?.cleared ?? '0');
  },

  deleteSigningRequests: async (db: Tx, limit: number): Promise<bigint> => {
    const result = await sql<{ deleted: string }>`
      select ujira.delete_stale_signing_requests(${limit}) as deleted
    `.execute(db);
    return BigInt(result.rows[0]?.deleted ?? '0');
  },
};

export const chainStoreRepositories = {
  chainSubmissions,
  legDeliveries,
  sponsorshipLedger,
  signingRequests,
} as const;
