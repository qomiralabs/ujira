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

export type IdentityState = 'pending' | 'verified' | 'rejected' | 'expired';

export interface RecipientIdentity {
  readonly id: string;
  readonly recipientId: string;
  readonly chain: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly state: string;
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
  'recipient_id',
  'chain',
  'provider',
  'provider_ref',
  'state',
] as const;

function toIdentity(row: {
  id: string;
  recipient_id: string;
  chain: string;
  provider: string;
  provider_ref: string;
  state: string;
}): RecipientIdentity {
  return {
    id: row.id,
    recipientId: row.recipient_id,
    chain: row.chain,
    provider: row.provider,
    providerRef: row.provider_ref,
    state: row.state,
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
