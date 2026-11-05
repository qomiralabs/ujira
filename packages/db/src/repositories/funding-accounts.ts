// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A principal's forwarding accounts, and the funding sources that use them. As
// with the other tenant tables, none of these takes a tenant id. Which rows a
// read sees is the session's: one project, or every project of the principal.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';
import { fundingSources, type FundingSource } from './mandates.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

// Rejected is what was found at creation, and is final for the app. Changed is an
// account verified at creation whose latest read found something else.
export type FundingAccountStatus = 'active' | 'rejected' | 'changed';

export interface FundingAccount {
  readonly id: string;
  readonly projectId: string;
  readonly network: string;
  readonly address: string;
  readonly sponsor: string;
  readonly sponsorTxHash: Buffer;
  readonly status: FundingAccountStatus;
  readonly faults: readonly string[];
  readonly createdAt: Date;
}

/** The status follows from the faults, so a caller cannot write one that disagrees. */
export interface NewFundingAccount {
  readonly network: string;
  readonly address: string;
  readonly sponsor: string;
  readonly sponsorTxHash: Buffer;
  readonly faults: readonly string[];
}

const columns = [
  'id',
  'project_id',
  'network',
  'address',
  'sponsor',
  'sponsor_tx_hash',
  'status',
  'faults',
  'created_at',
] as const;

function toAccount(row: {
  id: string;
  project_id: string;
  network: string;
  address: string;
  sponsor: string;
  sponsor_tx_hash: Buffer;
  status: string;
  faults: string[];
  created_at: Date;
}): FundingAccount {
  return {
    id: row.id,
    projectId: row.project_id,
    network: row.network,
    address: row.address,
    sponsor: row.sponsor,
    sponsorTxHash: row.sponsor_tx_hash,
    // The table's check allows these two and no others.
    status: row.status as FundingAccountStatus,
    faults: row.faults,
    createdAt: row.created_at,
  };
}

// What the latest read found, or nothing when it has never been read again.
async function latestFaults(db: Tx, accountId: string): Promise<readonly string[]> {
  const latest = await db
    .selectFrom('ujira.funding_account_checks')
    .select('faults')
    .where('funding_account_id', '=', accountId)
    .orderBy('checked_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return latest?.faults ?? [];
}

export const fundingAccounts = {
  forNetwork: async (db: Tx, network: string): Promise<FundingAccount | undefined> => {
    const row = await db
      .selectFrom('ujira.funding_accounts')
      .select(columns)
      .where('network', '=', network)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const account = toAccount(row);
    // A later good read does not undo what was found at creation.
    if (account.status === 'rejected') return account;
    const faults = await latestFaults(db, account.id);
    return faults.length === 0 ? account : { ...account, status: 'changed', faults };
  },

  // Beside the row, which stays as what was found at creation. An account that is
  // not this tenant's fails its key, with the tenant on the row.
  recordCheck: async (
    db: Tx,
    input: { readonly accountId: string; readonly faults: readonly string[] },
  ): Promise<void> => {
    await db
      .insertInto('ujira.funding_account_checks')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        funding_account_id: input.accountId,
        faults: [...input.faults],
      })
      .execute();
  },

  // Undefined when the principal already has an account on this network, or the
  // address is already held. The row that won may not be this session's to see,
  // so it is not returned, and the caller decides what the conflict means.
  record: async (db: Tx, input: NewFundingAccount): Promise<FundingAccount | undefined> => {
    const row = await db
      .insertInto('ujira.funding_accounts')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        network: input.network,
        address: input.address,
        sponsor: input.sponsor,
        sponsor_tx_hash: input.sponsorTxHash,
        status: input.faults.length === 0 ? 'active' : 'rejected',
        faults: [...input.faults],
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning(columns)
      .executeTakeFirst();
    return row === undefined ? undefined : toAccount(row);
  },

  // The instance's funding source for this account, made the first time it is
  // asked for. Undefined when this tenant has no such active account, or the
  // instance is already funded by a different one.
  //
  // The app cannot delete a funding source, so a second confirmation racing the
  // first must not get as far as creating one. The lock makes it wait and then
  // find the first's. The key on the instance holds even if something forgets to
  // take it.
  attach: async (
    db: Tx,
    input: { readonly accountId: string; readonly mandateInstanceId: string },
  ): Promise<FundingSource | undefined> => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${input.mandateInstanceId}, 0))`.execute(
      db,
    );
    const linked = await db
      .selectFrom('ujira.funding_account_sources')
      .select(['funding_account_id', 'funding_source_id'])
      .where('mandate_instance_id', '=', input.mandateInstanceId)
      .executeTakeFirst();
    if (linked !== undefined) {
      return linked.funding_account_id === input.accountId
        ? fundingSources.get(db, linked.funding_source_id)
        : undefined;
    }
    const account = await db
      .selectFrom('ujira.funding_accounts')
      .select(['sponsor_tx_hash'])
      .where('id', '=', input.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (account === undefined) return undefined;
    if ((await latestFaults(db, input.accountId)).length > 0) return undefined;
    const source = await fundingSources.create(db, {
      mandateInstanceId: input.mandateInstanceId,
      kind: 'stellar_funding_account',
      config: { sponsoredReserves: true, sponsorTxHash: account.sponsor_tx_hash },
    });
    await db
      .insertInto('ujira.funding_account_sources')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        funding_account_id: input.accountId,
        funding_source_id: source.id,
        mandate_instance_id: input.mandateInstanceId,
      })
      .execute();
    return source;
  },
};

export const fundingAccountRepositories = { fundingAccounts } as const;
