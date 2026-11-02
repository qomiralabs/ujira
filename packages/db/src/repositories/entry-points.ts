// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The two ways in that run before a tenant context exists, inside
// db.unscoped(). Each calls one security definer function owned by its own
// narrow role; nothing else is readable or writable in that transaction.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

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
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface ResolvedInstance {
  readonly principalId: string;
  readonly projectId: string;
  readonly mandateInstanceId: string;
  readonly asset: string;
  readonly scale: number;
}

export const entryPoints = {
  // The tenant of a deployed contract, or undefined when it is not one of
  // ours. This is how the indexer learns which context to write an event under,
  // so only the indexer's login may call it.
  resolveMandateInstance: async (
    db: Tx,
    chain: string,
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
        from ujira.resolve_mandate_instance(${chain}, ${contractAddress})
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
      expires_at: Date | null;
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
