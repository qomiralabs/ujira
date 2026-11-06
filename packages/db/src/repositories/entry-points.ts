// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The two ways in that run before a tenant context exists, inside
// db.unscoped(). Each calls one security definer function owned by its own
// narrow role; nothing else is readable or writable in that transaction.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';
import type { FundingAccountStatus } from './funding-accounts.js';
import { checkedLimit, pageOf, PageRequestError, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

export interface NewPrincipal {
  readonly name: string;
  readonly projectName: string;
  // The identity provider's subject of the person who becomes the owner.
  readonly ownerUserId: string;
  // An IANA zone; UTC when left out.
  readonly reportingTimeZone?: string;
}

export interface CreatedPrincipal {
  readonly principalId: string;
  readonly projectId: string;
}

export interface TokenRecord {
  readonly tokenId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly secretSha256: Buffer;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface ResolvedInstance {
  readonly principalId: string;
  readonly projectId: string;
  readonly mandateInstanceId: string;
  readonly asset: string;
  readonly scale: number;
}

export interface ResolvedFundingInstance {
  readonly fundingSourceId: string;
  readonly mandateInstanceId: string;
  readonly contractAddress: string;
  readonly asset: string;
}

export interface ResolvedFundingAddress {
  readonly principalId: string;
  readonly projectId: string;
  readonly fundingAccountId: string;
  readonly status: FundingAccountStatus;
  // Every mandate instance the account funds, which can be none or several.
  readonly instances: readonly ResolvedFundingInstance[];
}

export interface EmbedTokenRecord {
  readonly sessionId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly purpose: string;
  readonly allowedOrigins: readonly string[];
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface EmbedInviteExchangeInput {
  readonly inviteSha256: Buffer;
  readonly tokenSha256: Buffer;
  readonly tokenPrefix: string;
  readonly tokenSeconds: number;
  readonly origin: string;
}

/** An instance to compare with its contract, and the tenant to compare it under. */
export interface ReconcileTarget {
  readonly principalId: string;
  readonly projectId: string;
  readonly mandateInstanceId: string;
  readonly network: string;
  readonly contractAddress: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const entryPoints = {
  // Every active or paused instance, a page at a time in id order, for the
  // reconcile sweep, which then works on each under its own tenant. Only the
  // indexer's login may call it, and it tells nothing but where each instance lives.
  reconcileTargets: async (db: Tx, page: PageRequest): Promise<Page<ReconcileTarget>> => {
    const limit = checkedLimit(page.limit);
    if (page.after !== undefined && !UUID.test(page.after)) {
      throw new PageRequestError('after is not a key this list returned');
    }
    const result = await sql<{
      principal_id: string;
      project_id: string;
      mandate_instance_id: string;
      network: string;
      contract_address: string;
    }>`
      select principal_id, project_id, mandate_instance_id, network, contract_address
        from ujira.reconcile_targets(${page.after ?? null}::uuid, ${limit + 1})
    `.execute(db);
    return pageOf(
      result.rows.map((row) => ({
        principalId: row.principal_id,
        projectId: row.project_id,
        mandateInstanceId: row.mandate_instance_id,
        network: row.network,
        contractAddress: row.contract_address,
      })),
      limit,
      (target) => target.mandateInstanceId,
    );
  },

  // The embed token a hash names, whatever its tenant, or undefined. The caller
  // checks expiry, use and the origin.
  authenticateEmbedToken: async (
    db: Tx,
    tokenSha256: Buffer,
  ): Promise<EmbedTokenRecord | undefined> => {
    const result = await sql<{
      session_id: string;
      principal_id: string;
      project_id: string;
      recipient_id: string;
      purpose: string;
      allowed_origins: string[];
      expires_at: Date;
      consumed_at: Date | null;
    }>`
      select session_id, principal_id, project_id, recipient_id, purpose, allowed_origins,
             expires_at, consumed_at
        from ujira.authenticate_embed_token(${tokenSha256})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      sessionId: row.session_id,
      principalId: row.principal_id,
      projectId: row.project_id,
      recipientId: row.recipient_id,
      purpose: row.purpose,
      allowedOrigins: row.allowed_origins,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  },

  // Spends an invite and makes its token, or undefined when it cannot be spent.
  exchangeEmbedInvite: async (
    db: Tx,
    input: EmbedInviteExchangeInput,
  ): Promise<{ readonly expiresAt: Date } | undefined> => {
    const result = await sql<{ expires_at: Date }>`
      select expires_at
        from ujira.exchange_embed_invite(
          ${input.inviteSha256}, ${input.tokenSha256}, ${input.tokenPrefix},
          ${input.tokenSeconds}::integer, ${input.origin}
        )
    `.execute(db);
    const row = result.rows[0];
    return row === undefined ? undefined : { expiresAt: row.expires_at };
  },

  // The tenant of a deployed contract on one network, or undefined when it is not
  // one of ours there. This is how the indexer learns which context to write an
  // event under, so only the indexer's login may call it. The network, not its
  // chain, so a record on testnet can never answer for mainnet or the other way.
  resolveMandateInstance: async (
    db: Tx,
    network: string,
    contractAddress: string,
  ): Promise<ResolvedInstance | undefined> => {
    const result = await sql<{
      principal_id: string;
      project_id: string;
      mandate_instance_id: string;
      asset: string;
      scale: number;
    }>`
      select principal_id, project_id, mandate_instance_id, asset, scale
        from ujira.resolve_mandate_address(${network}, ${contractAddress})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      principalId: row.principal_id,
      projectId: row.project_id,
      mandateInstanceId: row.mandate_instance_id,
      asset: row.asset,
      scale: row.scale,
    };
  },

  // The tenant of a forwarding account, by its exact address, or undefined when it
  // is not one of ours. A deposit arrives before anyone knows whose it is, so only
  // the indexer's login may call it, and it cannot list anything.
  resolveFundingAddress: async (
    db: Tx,
    network: string,
    address: string,
  ): Promise<ResolvedFundingAddress | undefined> => {
    const result = await sql<{
      principal_id: string;
      project_id: string;
      funding_account_id: string;
      account_status: FundingAccountStatus;
      funding_source_id: string | null;
      mandate_instance_id: string | null;
      contract_address: string | null;
      asset: string | null;
    }>`
      select principal_id, project_id, funding_account_id, account_status,
             funding_source_id, mandate_instance_id, contract_address, asset
        from ujira.resolve_funding_address(${network}, ${address})
    `.execute(db);
    const [first] = result.rows;
    if (first === undefined) return undefined;
    const instances: ResolvedFundingInstance[] = [];
    for (const row of result.rows) {
      // The join brings all four or none, so an account with no instance has one row
      // with none of them.
      if (
        row.funding_source_id !== null &&
        row.mandate_instance_id !== null &&
        row.contract_address !== null &&
        row.asset !== null
      ) {
        instances.push({
          fundingSourceId: row.funding_source_id,
          mandateInstanceId: row.mandate_instance_id,
          contractAddress: row.contract_address,
          asset: row.asset,
        });
      }
    }
    return {
      principalId: first.principal_id,
      projectId: first.project_id,
      fundingAccountId: first.funding_account_id,
      status: first.account_status,
      instances,
    };
  },

  // The principal, its first project and its owner, all or none.
  createPrincipal: async (db: Tx, input: NewPrincipal): Promise<CreatedPrincipal> => {
    const result = await sql<{ principal_id: string; project_id: string }>`
      select principal_id, project_id
        from ujira.create_principal(
          ${input.name}, ${input.projectName}, ${input.ownerUserId}, ${input.reportingTimeZone ?? 'UTC'}
        )
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('create_principal returned no row');
    return { principalId: row.principal_id, projectId: row.project_id };
  },

  // The token the prefix names, whatever its tenant, or undefined. The
  // caller compares the secret's hash in constant time and checks expiry
  // and revocation before trusting the tenant it names.
  authenticateToken: async (db: Tx, prefix: string): Promise<TokenRecord | undefined> => {
    const result = await sql<{
      token_id: string;
      principal_id: string;
      project_id: string;
      secret_sha256: Buffer;
      scopes: string[];
      expires_at: Date;
      revoked_at: Date | null;
    }>`
      select token_id, principal_id, project_id, secret_sha256, scopes, expires_at, revoked_at
        from ujira.authenticate_token(${prefix})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      tokenId: row.token_id,
      principalId: row.principal_id,
      projectId: row.project_id,
      secretSha256: row.secret_sha256,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  },
};
