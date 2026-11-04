// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which projects a member below admin may see, and the wallets that show which
// person approved something. Both run under a tenant context, so another
// tenant's rows cannot be reached from here.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface MemberProjectGrant {
  readonly userId: string;
  readonly grantedBy: string;
  readonly createdAt: Date;
}

export const memberProjects = {
  // The members listed for the current project.
  list: async (db: Tx, page: PageRequest): Promise<Page<MemberProjectGrant>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.principal_member_projects')
      .select(['user_id', 'granted_by', 'created_at'])
      .orderBy('user_id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('user_id', '>', page.after);
    const rows = await query.execute();
    return pageOf(
      rows.map((row) => ({
        userId: row.user_id,
        grantedBy: row.granted_by,
        createdAt: row.created_at,
      })),
      limit,
      (grant) => grant.userId,
    );
  },

  // Lists a member for the current project. Granting twice changes nothing.
  grant: async (db: Tx, userId: string, grantedBy: string): Promise<void> => {
    await db
      .insertInto('ujira.principal_member_projects')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        user_id: userId,
        granted_by: grantedBy,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'user_id']).doNothing(),
      )
      .execute();
  },

  revoke: async (db: Tx, userId: string): Promise<boolean> => {
    const result = await db
      .deleteFrom('ujira.principal_member_projects')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  },
};

export interface MemberWallet {
  readonly id: string;
  readonly userId: string;
  readonly network: string;
  readonly address: string;
  readonly verifiedAt: Date;
  readonly removedAt: Date | null;
}

const walletColumns = ['id', 'user_id', 'network', 'address', 'verified_at', 'removed_at'] as const;

function toWallet(row: {
  id: string;
  user_id: string;
  network: string;
  address: string;
  verified_at: Date;
  removed_at: Date | null;
}): MemberWallet {
  return {
    id: row.id,
    userId: row.user_id,
    network: row.network,
    address: row.address,
    verifiedAt: row.verified_at,
    removedAt: row.removed_at,
  };
}

export const memberWallets = {
  // Every link of one member, ended ones included.
  list: async (db: Tx, userId: string): Promise<MemberWallet[]> => {
    const rows = await db
      .selectFrom('ujira.member_wallets')
      .select(walletColumns)
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute();
    return rows.map(toWallet);
  },

  // Refused while the address is linked to anyone in this principal.
  link: async (
    db: Tx,
    input: {
      readonly userId: string;
      readonly network: string;
      readonly address: string;
      readonly verifiedAt: Date;
    },
  ): Promise<MemberWallet> => {
    const row = await db
      .insertInto('ujira.member_wallets')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        user_id: input.userId,
        network: input.network,
        address: input.address,
        verified_at: input.verifiedAt,
      })
      .returning(walletColumns)
      .executeTakeFirstOrThrow();
    return toWallet(row);
  },

  // Ends a link and keeps the row, so what it approved can still be traced.
  remove: async (db: Tx, walletId: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.member_wallets')
      .set({ removed_at: sql`now()` })
      .where('id', '=', walletId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },

  // Erasing a member removes their wallets outright. The identity provider's
  // user is deleted through its admin API once this has committed.
  eraseMember: async (db: Tx, userId: string): Promise<number> => {
    const result = await db
      .deleteFrom('ujira.member_wallets')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  },
};

// For the cross-tenant matrix, which requires a case for each method listed here.
export const memberAccessRepositories = { memberProjects, memberWallets } as const;
