// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Repository methods for the tenant roots. Each runs inside a transaction
// that db.tenant() or db.principal() opened, and none of them takes a tenant
// id: what a method can see and change is decided by the row level security
// policies against the transaction's context, and a new row takes its tenant
// from that context on the server. A caller holding another tenant's id gets
// nothing back with it; cross-tenant.test.ts runs every method here that
// way.

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';
import { audit, type AuditActor } from './audit.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';
import type { CashoutCostBearer } from './payouts.js';
import { managedSigners } from './signers.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export type ChainFallback = 'off' | 'verified_methods';

export interface ProjectSettings {
  readonly cashoutCostBearer: CashoutCostBearer;
  readonly chainFallback: ChainFallback;
  readonly fundingHoldMaxSeconds: number;
}

export interface Principal {
  readonly id: string;
  readonly name: string;
  readonly reportingTimeZone: string;
  readonly createdAt: Date;
}

export interface Project {
  readonly id: string;
  readonly principalId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export type MemberRole = 'owner' | 'admin' | 'developer' | 'viewer';

export interface Member {
  readonly userId: string;
  readonly role: MemberRole;
  readonly createdAt: Date;
}

export interface ApiToken {
  readonly id: string;
  readonly projectId: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  // The token this one replaced, in the same project, or null for a first one.
  readonly rotatedFromId: string | null;
  readonly createdAt: Date;
}

export interface NewApiToken {
  readonly prefix: string;
  // SHA-256 of the secret, 32 bytes. The secret itself never reaches here.
  readonly secretSha256: Buffer;
  readonly scopes: readonly string[];
  // Every token expires: rotation is the only way to keep one working.
  readonly expiresAt: Date;
  readonly rotatedFromId?: string;
}

const MEMBER_ROLES: ReadonlySet<string> = new Set<MemberRole>([
  'owner',
  'admin',
  'developer',
  'viewer',
]);

function memberRole(value: string): MemberRole {
  if (!MEMBER_ROLES.has(value)) {
    // The column's check constraint makes this unreachable unless the two
    // lists drift, which is worth failing loudly on.
    throw new Error('a member row holds a role this code does not know');
  }
  return value as MemberRole;
}

const principalColumns = ['id', 'name', 'reporting_time_zone', 'created_at'] as const;

function toPrincipal(row: {
  id: string;
  name: string;
  reporting_time_zone: string;
  created_at: Date;
}): Principal {
  return {
    id: row.id,
    name: row.name,
    reportingTimeZone: row.reporting_time_zone,
    createdAt: row.created_at,
  };
}

export const principals = {
  // The transaction's own principal.
  current: async (db: Tx): Promise<Principal | undefined> => {
    const row = await db
      .selectFrom('ujira.principals')
      .select(principalColumns)
      .where('id', '=', CURRENT_PRINCIPAL)
      .executeTakeFirst();
    return row === undefined ? undefined : toPrincipal(row);
  },

  get: async (db: Tx, id: string): Promise<Principal | undefined> => {
    const row = await db
      .selectFrom('ujira.principals')
      .select(principalColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPrincipal(row);
  },

  // True when the principal was found and changed. A zone the server does
  // not know is refused by the database with 22023.
  setReportingTimeZone: async (db: Tx, id: string, zone: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.principals')
      .set({ reporting_time_zone: zone })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

const projectColumns = ['id', 'principal_id', 'name', 'created_at'] as const;

function toProject(row: {
  id: string;
  principal_id: string;
  name: string;
  created_at: Date;
}): Project {
  return { id: row.id, principalId: row.principal_id, name: row.name, createdAt: row.created_at };
}

export const projects = {
  list: async (db: Tx, page: PageRequest): Promise<Page<Project>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.projects')
      .select(projectColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toProject), limit, (project) => project.id);
  },

  get: async (db: Tx, id: string): Promise<Project | undefined> => {
    const row = await db
      .selectFrom('ujira.projects')
      .select(projectColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toProject(row);
  },

  // A new project of the transaction's principal. The id is made here: the
  // transaction's project scope cannot read a different project back, so
  // the insert returns nothing.
  create: async (db: Tx, input: { readonly name: string }): Promise<string> => {
    const id = randomUUID();
    await db
      .insertInto('ujira.projects')
      .values({ id, name: input.name, principal_id: CURRENT_PRINCIPAL })
      .execute();
    return id;
  },

  rename: async (db: Tx, id: string, name: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.projects')
      .set({ name })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },

  // The settings of the transaction's own project.
  settings: async (db: Tx): Promise<ProjectSettings | undefined> => {
    const row = await db
      .selectFrom('ujira.projects')
      .select(['cashout_cost_bearer', 'chain_fallback', 'funding_hold_max_seconds'])
      .where('id', '=', CURRENT_PROJECT)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          cashoutCostBearer: row.cashout_cost_bearer as CashoutCostBearer,
          chainFallback: row.chain_fallback as ChainFallback,
          fundingHoldMaxSeconds: Number(row.funding_hold_max_seconds),
        };
  },

  // Each of these changes the setting and writes its audit row in one transaction.
  // Setting what is already there changes nothing and writes nothing. Payouts
  // already created keep the bearer they were created under.
  setCashoutBearer: async (
    db: Tx,
    bearer: CashoutCostBearer,
    actor: AuditActor,
  ): Promise<boolean> => {
    const current = await lockedSettings(db);
    if (current.cashout_cost_bearer === bearer) return false;
    await db
      .updateTable('ujira.projects')
      .set({ cashout_cost_bearer: bearer })
      .where('id', '=', CURRENT_PROJECT)
      .execute();
    await audit.record(db, {
      action: 'project.cashout_bearer_changed',
      actor,
      metadata: {
        setting: 'cashout_cost_bearer',
        old_value: current.cashout_cost_bearer,
        new_value: bearer,
      },
    });
    return true;
  },

  // One audit row per setting that changed.
  setRoutingSettings: async (
    db: Tx,
    settings: {
      readonly chainFallback?: ChainFallback;
      readonly fundingHoldMaxSeconds?: number;
    },
    actor: AuditActor,
  ): Promise<number> => {
    const current = await lockedSettings(db);
    const seconds = settings.fundingHoldMaxSeconds?.toString();
    const fallback = settings.chainFallback;
    const changes: { setting: string; old_value: string; new_value: string }[] = [];
    if (fallback !== undefined && fallback !== current.chain_fallback) {
      changes.push({
        setting: 'chain_fallback',
        old_value: current.chain_fallback,
        new_value: fallback,
      });
    }
    if (seconds !== undefined && seconds !== current.funding_hold_max_seconds) {
      changes.push({
        setting: 'funding_hold_max_seconds',
        old_value: current.funding_hold_max_seconds,
        new_value: seconds,
      });
    }
    if (changes.length === 0) return 0;
    await db
      .updateTable('ujira.projects')
      .set({
        ...(fallback === undefined ? {} : { chain_fallback: fallback }),
        ...(seconds === undefined ? {} : { funding_hold_max_seconds: seconds }),
      })
      .where('id', '=', CURRENT_PROJECT)
      .execute();
    for (const metadata of changes) {
      await audit.record(db, { action: 'project.routing_settings_changed', actor, metadata });
    }
    return changes.length;
  },
};

// Locked, so the old value an audit row records is the one really replaced.
async function lockedSettings(db: Tx): Promise<{
  cashout_cost_bearer: string;
  chain_fallback: string;
  funding_hold_max_seconds: string;
}> {
  return db
    .selectFrom('ujira.projects')
    .select(['cashout_cost_bearer', 'chain_fallback', 'funding_hold_max_seconds'])
    .where('id', '=', CURRENT_PROJECT)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

const memberColumns = ['user_id', 'role', 'created_at'] as const;

function toMember(row: { user_id: string; role: string; created_at: Date }): Member {
  return { userId: row.user_id, role: memberRole(row.role), createdAt: row.created_at };
}

export const members = {
  list: async (db: Tx, page: PageRequest): Promise<Page<Member>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.principal_members')
      .select(memberColumns)
      .orderBy('user_id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('user_id', '>', page.after);
    return pageOf((await query.execute()).map(toMember), limit, (member) => member.userId);
  },

  get: async (db: Tx, userId: string): Promise<Member | undefined> => {
    const row = await db
      .selectFrom('ujira.principal_members')
      .select(memberColumns)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row === undefined ? undefined : toMember(row);
  },

  add: async (
    db: Tx,
    input: { readonly userId: string; readonly role: MemberRole },
  ): Promise<Member> => {
    const row = await db
      .insertInto('ujira.principal_members')
      .values({ principal_id: CURRENT_PRINCIPAL, user_id: input.userId, role: input.role })
      .returning(memberColumns)
      .executeTakeFirstOrThrow();
    return toMember(row);
  },

  changeRole: async (db: Tx, userId: string, role: MemberRole): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.principal_members')
      .set({ role })
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

const tokenColumns = [
  'id',
  'project_id',
  'prefix',
  'scopes',
  'expires_at',
  'revoked_at',
  'rotated_from_id',
  'created_at',
] as const;

function toToken(row: {
  id: string;
  project_id: string;
  prefix: string;
  scopes: string[];
  expires_at: Date;
  revoked_at: Date | null;
  rotated_from_id: string | null;
  created_at: Date;
}): ApiToken {
  return {
    id: row.id,
    projectId: row.project_id,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    rotatedFromId: row.rotated_from_id,
    createdAt: row.created_at,
  };
}

export const apiTokens = {
  list: async (db: Tx, page: PageRequest): Promise<Page<ApiToken>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.api_tokens')
      .select(tokenColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toToken), limit, (token) => token.id);
  },

  get: async (db: Tx, id: string): Promise<ApiToken | undefined> => {
    const row = await db
      .selectFrom('ujira.api_tokens')
      .select(tokenColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toToken(row);
  },

  create: async (db: Tx, input: NewApiToken): Promise<ApiToken> => {
    const row = await db
      .insertInto('ujira.api_tokens')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        prefix: input.prefix,
        secret_sha256: input.secretSha256,
        scopes: [...input.scopes],
        expires_at: input.expiresAt,
        rotated_from_id: input.rotatedFromId ?? null,
      })
      .returning(tokenColumns)
      .executeTakeFirstOrThrow();
    return toToken(row);
  },

  // True when a live token was found and revoked. Revoking is permanent:
  // the database refuses to clear or move revoked_at once set (UJ006).
  revoke: async (db: Tx, id: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.api_tokens')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

// Every tenant repository, for the cross-tenant matrix, which requires a
// case for each method listed here.
export const tenancyRepositories = {
  principals,
  projects,
  members,
  apiTokens,
  managedSigners,
} as const;
