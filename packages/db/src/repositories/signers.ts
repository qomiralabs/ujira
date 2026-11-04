// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where signing keys are recorded. Neither table holds key material, only the
// key manager's name for a key and the account it controls.
//
// managedSigners runs inside a transaction db.tenant() or db.principal()
// opened and takes no tenant id: row level security decides what it can see
// and change, and a new row takes its tenant from the context on the server.
//
// signingKeys reads infrastructure keys through the one narrow function the app
// may call, inside db.unscoped(), since these rows belong to no tenant.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export type SignerKeyStatus = 'active' | 'retiring' | 'retired';

export interface ManagedSigner {
  readonly id: string;
  readonly projectId: string;
  readonly network: string;
  readonly agentId: string;
  readonly keyRef: string;
  readonly address: string;
  readonly status: SignerKeyStatus;
  readonly consentedByMemberId: string;
  readonly createdAt: Date;
}

export interface NewManagedSigner {
  readonly network: string;
  readonly agentId: string;
  readonly keyRef: string;
  readonly address: string;
  readonly consentedByMemberId: string;
}

const STATUSES: ReadonlySet<string> = new Set<SignerKeyStatus>(['active', 'retiring', 'retired']);

function signerStatus(value: string): SignerKeyStatus {
  if (!STATUSES.has(value)) {
    // The column's check constraint makes this unreachable unless the two
    // lists drift, which is worth failing loudly on.
    throw new Error('a signer row holds a status this code does not know');
  }
  return value as SignerKeyStatus;
}

const signerColumns = [
  'id',
  'project_id',
  'network',
  'agent_id',
  'key_ref',
  'address',
  'status',
  'consented_by_member_id',
  'created_at',
] as const;

function toManagedSigner(row: {
  id: string;
  project_id: string;
  network: string;
  agent_id: string;
  key_ref: string;
  address: string;
  status: string;
  consented_by_member_id: string;
  created_at: Date;
}): ManagedSigner {
  return {
    id: row.id,
    projectId: row.project_id,
    network: row.network,
    agentId: row.agent_id,
    keyRef: row.key_ref,
    address: row.address,
    status: signerStatus(row.status),
    consentedByMemberId: row.consented_by_member_id,
    createdAt: row.created_at,
  };
}

export const managedSigners = {
  list: async (db: Tx, page: PageRequest): Promise<Page<ManagedSigner>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.managed_signers')
      .select(signerColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toManagedSigner), limit, (signer) => signer.id);
  },

  get: async (db: Tx, id: string): Promise<ManagedSigner | undefined> => {
    const row = await db
      .selectFrom('ujira.managed_signers')
      .select(signerColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toManagedSigner(row);
  },

  // The key that signs for this agent on this network, if any.
  active: async (
    db: Tx,
    input: { readonly network: string; readonly agentId: string },
  ): Promise<ManagedSigner | undefined> => {
    const row = await db
      .selectFrom('ujira.managed_signers')
      .select(signerColumns)
      .where('network', '=', input.network)
      .where('agent_id', '=', input.agentId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return row === undefined ? undefined : toManagedSigner(row);
  },

  // A second active key for the same agent and network is refused by the
  // database with 23505, and so is an account another key already controls.
  create: async (db: Tx, input: NewManagedSigner): Promise<ManagedSigner> => {
    const row = await db
      .insertInto('ujira.managed_signers')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        network: input.network,
        agent_id: input.agentId,
        key_ref: input.keyRef,
        address: input.address,
        consented_by_member_id: input.consentedByMemberId,
      })
      .returning(signerColumns)
      .executeTakeFirstOrThrow();
    return toManagedSigner(row);
  },

  // True when the key was found and moved. A move the key's life does not allow
  // is refused by the database with UJ004.
  setStatus: async (
    db: Tx,
    id: string,
    status: Exclude<SignerKeyStatus, 'active'>,
  ): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.managed_signers')
      .set({ status })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export type SigningKeyPurpose = 'executor' | 'fee_sponsor' | 'sep10' | 'attester' | 'pii_kek';

export interface SigningKey {
  readonly purpose: SigningKeyPurpose;
  readonly network: string | null;
  readonly anchorId: string | null;
  readonly provider: string;
  readonly keyRef: string;
  readonly address: string | null;
  readonly publicKey: Uint8Array | null;
}

export const signingKeys = {
  // The active keys for these purposes, for a service to check at startup. Rows
  // are written by the operations login, never by the app.
  active: async (db: Tx, purposes: readonly SigningKeyPurpose[]): Promise<SigningKey[]> => {
    const result = await sql<{
      purpose: SigningKeyPurpose;
      network: string | null;
      anchor_id: string | null;
      provider: string;
      key_ref: string;
      account: string | null;
      public_key: Buffer | null;
    }>`
      select purpose, network, anchor_id, provider, key_ref, account, public_key
        from ops.active_signing_keys(${[...purposes]}::text[])
    `.execute(db);
    return result.rows.map((row) => ({
      purpose: row.purpose,
      network: row.network,
      anchorId: row.anchor_id,
      provider: row.provider,
      keyRef: row.key_ref,
      address: row.account,
      publicKey: row.public_key === null ? null : Uint8Array.from(row.public_key),
    }));
  },
};
