// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Repository methods for recipients and how they are paid. Personal data passes
// through here only as ciphertext the caller already encrypted, and only for
// recipientPii. As everywhere, no method takes a tenant id.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export type RecipientStatus = 'active' | 'suspended' | 'erased';

export interface Recipient {
  readonly id: string;
  readonly recipientRef: Buffer;
  readonly country: string;
  readonly status: string;
  readonly createdAt: Date;
}

const recipientColumns = ['id', 'recipient_ref', 'country', 'status', 'created_at'] as const;

function toRecipient(row: {
  id: string;
  recipient_ref: Buffer;
  country: string;
  status: string;
  created_at: Date;
}): Recipient {
  return {
    id: row.id,
    recipientRef: row.recipient_ref,
    country: row.country,
    status: row.status,
    createdAt: row.created_at,
  };
}

export const recipients = {
  list: async (db: Tx, page: PageRequest): Promise<Page<Recipient>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.recipients')
      .select(recipientColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toRecipient), limit, (recipient) => recipient.id);
  },

  get: async (db: Tx, id: string): Promise<Recipient | undefined> => {
    const row = await db
      .selectFrom('ujira.recipients')
      .select(recipientColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecipient(row);
  },

  // The same recipient_ref twice in one project is refused with 23505.
  create: async (
    db: Tx,
    input: { readonly recipientRef: Buffer; readonly country: string },
  ): Promise<Recipient> => {
    const row = await db
      .insertInto('ujira.recipients')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_ref: input.recipientRef,
        country: input.country,
      })
      .returning(recipientColumns)
      .executeTakeFirstOrThrow();
    return toRecipient(row);
  },

  // False when this reference already names a recipient, so a second run of one
  // request finds the first run's row rather than failing or making another.
  createOnce: async (
    db: Tx,
    input: { readonly id: string; readonly recipientRef: Buffer; readonly country: string },
  ): Promise<boolean> => {
    const row = await db
      .insertInto('ujira.recipients')
      .values({
        id: input.id,
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_ref: input.recipientRef,
        country: input.country,
      })
      .onConflict((conflict) => conflict.constraint('recipients_ref_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  },

  getByRef: async (db: Tx, recipientRef: Buffer): Promise<Recipient | undefined> => {
    const row = await db
      .selectFrom('ujira.recipients')
      .select(recipientColumns)
      .where('recipient_ref', '=', recipientRef)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecipient(row);
  },

  setStatus: async (db: Tx, id: string, status: RecipientStatus): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.recipients')
      .set({ status })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export interface EncryptedValue {
  readonly ciphertext: Buffer;
  // 12 bytes.
  readonly nonce: Buffer;
}

export const recipientPii = {
  // Stores or replaces the recipient's encrypted personal data.
  put: async (db: Tx, recipientId: string, value: EncryptedValue): Promise<void> => {
    await db
      .insertInto('ujira.recipient_pii')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_id: recipientId,
        ciphertext: value.ciphertext,
        nonce: value.nonce,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['principal_id', 'project_id', 'recipient_id'])
          .doUpdateSet({ ciphertext: value.ciphertext, nonce: value.nonce }),
      )
      .execute();
  },

  get: async (db: Tx, recipientId: string): Promise<EncryptedValue | undefined> => {
    const row = await db
      .selectFrom('ujira.recipient_pii')
      .select(['ciphertext', 'nonce'])
      .where('recipient_id', '=', recipientId)
      .executeTakeFirst();
    return row === undefined ? undefined : { ciphertext: row.ciphertext, nonce: row.nonce };
  },
};

export type IdentityState = 'pending' | 'verified' | 'rejected' | 'expired' | 'revoked';

export type IdentityAssurance = 'anchor_kyc' | 'document_zk' | 'principal_kyc' | 'none';

// A copy of what a provider last said: references, statuses and digests, never
// a document, a proof or a personal value.
export interface RecipientIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly recipientId: string;
  // Null for a provider that is not per chain.
  readonly chain: string | null;
  readonly provider: string;
  // Null before a provider has answered, and again after erasure.
  readonly providerRef: string | null;
  readonly state: string;
  readonly providerAccount: string | null;
  readonly providerSubject: string | null;
  readonly providerStatus: string | null;
  readonly assurance: string;
  readonly flowRef: string | null;
  readonly nullifierHmac: Buffer | null;
  readonly pendingSessionId: string | null;
  readonly pendingSessionUrl: string | null;
  readonly pendingSessionExpiresAt: Date | null;
  readonly failureReason: string | null;
  readonly rawSha256: Buffer | null;
  readonly lastCheckedAt: Date | null;
  readonly expiresAt: Date | null;
}

export interface NewProviderIdentity {
  readonly recipientId: string;
  readonly provider: string;
  readonly providerAccount: string | null;
}

// What a provider's result or a new session changes. A field left out stays as
// it is, and null clears it.
export interface IdentityChange {
  readonly state?: IdentityState;
  readonly providerRef?: string | null;
  readonly providerSubject?: string | null;
  readonly providerStatus?: string | null;
  readonly assurance?: IdentityAssurance;
  readonly flowRef?: string | null;
  readonly nullifierHmac?: Buffer | null;
  readonly pendingSessionId?: string | null;
  readonly pendingSessionUrl?: string | null;
  readonly pendingSessionExpiresAt?: Date | null;
  readonly failureReason?: string | null;
  readonly rawSha256?: Buffer | null;
  readonly lastCheckedAt?: Date | null;
  readonly expiresAt?: Date | null;
}

// A row as the identity service makes it, with an id of its own, so a provider's
// callback can name it before the provider has answered.
export interface NewIdentityRecord extends IdentityChange {
  readonly id: string;
  readonly recipientId: string;
  readonly provider: string;
  readonly providerAccount: string | null;
  readonly state: IdentityState;
}

export interface IdentityUpdate {
  readonly recipientId: string;
  readonly chain: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly state: IdentityState;
}

const identityColumns = [
  'id',
  'project_id',
  'recipient_id',
  'chain',
  'provider',
  'provider_ref',
  'state',
  'provider_account',
  'provider_subject',
  'provider_status',
  'assurance',
  'flow_ref',
  'nullifier_hmac',
  'pending_session_id',
  'pending_session_url',
  'pending_session_expires_at',
  'failure_reason',
  'raw_sha256',
  'last_checked_at',
  'expires_at',
] as const;

function toIdentity(row: {
  id: string;
  project_id: string;
  recipient_id: string;
  chain: string | null;
  provider: string;
  provider_ref: string | null;
  state: string;
  provider_account: string | null;
  provider_subject: string | null;
  provider_status: string | null;
  assurance: string;
  flow_ref: string | null;
  nullifier_hmac: Buffer | null;
  pending_session_id: string | null;
  pending_session_url: string | null;
  pending_session_expires_at: Date | null;
  failure_reason: string | null;
  raw_sha256: Buffer | null;
  last_checked_at: Date | null;
  expires_at: Date | null;
}): RecipientIdentity {
  return {
    id: row.id,
    projectId: row.project_id,
    recipientId: row.recipient_id,
    chain: row.chain,
    provider: row.provider,
    providerRef: row.provider_ref,
    state: row.state,
    providerAccount: row.provider_account,
    providerSubject: row.provider_subject,
    providerStatus: row.provider_status,
    assurance: row.assurance,
    flowRef: row.flow_ref,
    nullifierHmac: row.nullifier_hmac,
    pendingSessionId: row.pending_session_id,
    pendingSessionUrl: row.pending_session_url,
    pendingSessionExpiresAt: row.pending_session_expires_at,
    failureReason: row.failure_reason,
    rawSha256: row.raw_sha256,
    lastCheckedAt: row.last_checked_at,
    expiresAt: row.expires_at,
  };
}

// Only what the change names, so an update never writes back a stale copy.
function identityColumnsOf(change: IdentityChange) {
  return {
    ...(change.state === undefined ? {} : { state: change.state }),
    ...(change.providerRef === undefined ? {} : { provider_ref: change.providerRef }),
    ...(change.providerSubject === undefined ? {} : { provider_subject: change.providerSubject }),
    ...(change.providerStatus === undefined ? {} : { provider_status: change.providerStatus }),
    ...(change.assurance === undefined ? {} : { assurance: change.assurance }),
    ...(change.flowRef === undefined ? {} : { flow_ref: change.flowRef }),
    ...(change.nullifierHmac === undefined ? {} : { nullifier_hmac: change.nullifierHmac }),
    ...(change.pendingSessionId === undefined
      ? {}
      : { pending_session_id: change.pendingSessionId }),
    ...(change.pendingSessionUrl === undefined
      ? {}
      : { pending_session_url: change.pendingSessionUrl }),
    ...(change.pendingSessionExpiresAt === undefined
      ? {}
      : { pending_session_expires_at: change.pendingSessionExpiresAt }),
    ...(change.failureReason === undefined ? {} : { failure_reason: change.failureReason }),
    ...(change.rawSha256 === undefined ? {} : { raw_sha256: change.rawSha256 }),
    ...(change.lastCheckedAt === undefined ? {} : { last_checked_at: change.lastCheckedAt }),
    ...(change.expiresAt === undefined ? {} : { expires_at: change.expiresAt }),
  };
}

export const recipientIdentities = {
  list: async (db: Tx, recipientId: string): Promise<RecipientIdentity[]> => {
    const rows = await db
      .selectFrom('ujira.recipient_identities')
      .select(identityColumns)
      .where('recipient_id', '=', recipientId)
      .orderBy('chain')
      .orderBy('provider')
      .execute();
    return rows.map(toIdentity);
  },

  // Records what the provider last said for a recipient on a chain.
  upsert: async (db: Tx, input: IdentityUpdate): Promise<RecipientIdentity> => {
    const row = await db
      .insertInto('ujira.recipient_identities')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_id: input.recipientId,
        chain: input.chain,
        provider: input.provider,
        provider_ref: input.providerRef,
        state: input.state,
      })
      .onConflict((conflict) =>
        conflict
          .constraint('recipient_identities_per_chain')
          .doUpdateSet({ provider_ref: input.providerRef, state: input.state }),
      )
      .returning(identityColumns)
      .executeTakeFirstOrThrow();
    return toIdentity(row);
  },

  get: async (db: Tx, id: string): Promise<RecipientIdentity | undefined> => {
    const row = await db
      .selectFrom('ujira.recipient_identities')
      .select(identityColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toIdentity(row);
  },

  // A pending row for a provider that is not per chain, before it has answered.
  // A second one for the same provider and account is refused with 23505.
  open: async (db: Tx, input: NewProviderIdentity): Promise<RecipientIdentity> => {
    const row = await db
      .insertInto('ujira.recipient_identities')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_id: input.recipientId,
        provider: input.provider,
        provider_account: input.providerAccount,
        state: 'pending',
      })
      .returning(identityColumns)
      .executeTakeFirstOrThrow();
    return toIdentity(row);
  },

  // Undefined when the row is not there. A verified row whose nullifier another
  // verified row of the principal holds is refused with 23505.
  update: async (
    db: Tx,
    id: string,
    change: IdentityChange,
  ): Promise<RecipientIdentity | undefined> => {
    const row = await db
      .updateTable('ujira.recipient_identities')
      .set(identityColumnsOf(change))
      .where('id', '=', id)
      .returning(identityColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toIdentity(row);
  },

  // A second row for the same recipient, provider and account is refused with 23505.
  create: async (db: Tx, input: NewIdentityRecord): Promise<RecipientIdentity> => {
    const row = await db
      .insertInto('ujira.recipient_identities')
      .values({
        ...identityColumnsOf(input),
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        id: input.id,
        recipient_id: input.recipientId,
        provider: input.provider,
        provider_account: input.providerAccount,
        state: input.state,
      })
      .returning(identityColumns)
      .executeTakeFirstOrThrow();
    return toIdentity(row);
  },

  // Whose a row is, by its id alone, since a provider's callback names nothing else.
  // Run with no tenant: it answers for one exact id and cannot list anything.
  scopeOf: async (
    db: Tx,
    id: string,
  ): Promise<{ readonly principalId: string; readonly projectId: string } | undefined> => {
    const result = await sql<{ principal_id: string; project_id: string }>`
      select principal_id, project_id from ujira.recipient_identity_scope(${id})
    `.execute(db);
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { principalId: row.principal_id, projectId: row.project_id };
  },

  // The verified row holding this nullifier. Run under a principal context to
  // look across all of the principal's projects, as the unique rule does.
  verifiedByNullifier: async (
    db: Tx,
    nullifierHmac: Buffer,
  ): Promise<RecipientIdentity | undefined> => {
    const row = await db
      .selectFrom('ujira.recipient_identities')
      .select(identityColumns)
      .where('nullifier_hmac', '=', nullifierHmac)
      .where('state', '=', 'verified')
      .executeTakeFirst();
    return row === undefined ? undefined : toIdentity(row);
  },

  // Part of erasing a recipient: every row is revoked, and everything that could
  // tie it back to a person at the provider is cleared. Returns how many rows.
  erase: async (db: Tx, recipientId: string): Promise<number> => {
    const result = await db
      .updateTable('ujira.recipient_identities')
      .set({
        state: 'revoked',
        provider_ref: null,
        provider_subject: null,
        nullifier_hmac: null,
        pending_session_id: null,
        pending_session_url: null,
        pending_session_expires_at: null,
      })
      .where('recipient_id', '=', recipientId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  },
};

export type PayoutMethodKind = 'stellar_wallet' | 'bank' | 'mobile_money' | 'cash_pickup';

export interface PayoutMethod {
  readonly id: string;
  readonly recipientId: string;
  readonly method: string;
  readonly rail: string;
  readonly chain: string;
  readonly destinationAddress: string;
  // Exact: a tag runs to 2^64 - 1, past what a number can hold.
  readonly destinationTag: bigint | null;
  readonly details: EncryptedValue | null;
  readonly status: string;
}

export interface NewPayoutMethod {
  readonly recipientId: string;
  readonly method: PayoutMethodKind;
  readonly rail: 'wallet' | 'anchor';
  readonly chain: string;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly details: EncryptedValue | null;
}

const methodColumns = [
  'id',
  'recipient_id',
  'method',
  'rail',
  'chain',
  'destination_address',
  'destination_tag',
  'details_ciphertext',
  'details_nonce',
  'status',
] as const;

function toMethod(row: {
  id: string;
  recipient_id: string;
  method: string;
  rail: string;
  chain: string;
  destination_address: string;
  destination_tag: string | null;
  details_ciphertext: Buffer | null;
  details_nonce: Buffer | null;
  status: string;
}): PayoutMethod {
  return {
    id: row.id,
    recipientId: row.recipient_id,
    method: row.method,
    rail: row.rail,
    chain: row.chain,
    destinationAddress: row.destination_address,
    destinationTag: row.destination_tag === null ? null : BigInt(row.destination_tag),
    details:
      row.details_ciphertext === null || row.details_nonce === null
        ? null
        : { ciphertext: row.details_ciphertext, nonce: row.details_nonce },
    status: row.status,
  };
}

export const payoutMethods = {
  list: async (db: Tx, page: PageRequest): Promise<Page<PayoutMethod>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.payout_methods')
      .select(methodColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toMethod), limit, (method) => method.id);
  },

  get: async (db: Tx, id: string): Promise<PayoutMethod | undefined> => {
    const row = await db
      .selectFrom('ujira.payout_methods')
      .select(methodColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toMethod(row);
  },

  // Bounded, because the read of one recipient answers with all of these at once.
  listOf: async (db: Tx, recipientId: string): Promise<PayoutMethod[]> => {
    const rows = await db
      .selectFrom('ujira.payout_methods')
      .select(methodColumns)
      .where('recipient_id', '=', recipientId)
      .orderBy('id')
      .limit(50)
      .execute();
    return rows.map(toMethod);
  },

  create: async (db: Tx, input: NewPayoutMethod): Promise<PayoutMethod> => {
    const row = await db
      .insertInto('ujira.payout_methods')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        recipient_id: input.recipientId,
        method: input.method,
        rail: input.rail,
        chain: input.chain,
        destination_address: input.destinationAddress,
        has_tag: input.destinationTag !== null,
        destination_tag: input.destinationTag === null ? null : input.destinationTag.toString(),
        details_ciphertext: input.details?.ciphertext ?? null,
        details_nonce: input.details?.nonce ?? null,
      })
      .returning(methodColumns)
      .executeTakeFirstOrThrow();
    return toMethod(row);
  },

  // True when an active method was found and disabled.
  disable: async (db: Tx, id: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.payout_methods')
      .set({ status: 'disabled' })
      .where('id', '=', id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export const recipientRepositories = {
  recipients,
  recipientPii,
  recipientIdentities,
  payoutMethods,
} as const;
