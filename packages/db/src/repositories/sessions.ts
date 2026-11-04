// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Dashboard sessions, inside db.unscoped(), since a session is how a tenant
// context is found. Each call is one security definer function: nothing can read
// the table, and a session is reached only through the hash of its secret. The
// secret itself never comes here.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;

export type SessionAssurance = 'aal1' | 'aal2';

export interface NewMemberSession {
  readonly secretHash: Buffer;
  // The identity provider's subject of the person who signed in.
  readonly authSubject: string;
  readonly supabaseSessionId: string;
  readonly aal: SessionAssurance;
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
  // An HMAC the caller computed, never the address.
  readonly ipHmac: Buffer | null;
  readonly userAgentFamily: string | null;
}

export interface CreatedSession {
  readonly sessionId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly authSubject: string;
  readonly supabaseSessionId: string;
  readonly aal: string;
  readonly principalId: string | null;
  readonly projectId: string | null;
  // The person's role in the chosen principal, null until one is chosen.
  readonly memberRole: string | null;
  readonly steppedUpAt: Date | null;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface Membership {
  readonly principalId: string;
  readonly role: string;
}

export const memberSessions = {
  // The principals this person is an active member of.
  memberships: async (db: Tx, authSubject: string): Promise<Membership[]> => {
    const result = await sql<{ principal_id: string; role: string }>`
      select principal_id, role from ujira.member_memberships(${authSubject}::uuid)
    `.execute(db);
    return result.rows.map((row) => ({ principalId: row.principal_id, role: row.role }));
  },

  create: async (db: Tx, session: NewMemberSession): Promise<CreatedSession> => {
    const result = await sql<{
      session_id: string;
      idle_expires_at: Date;
      absolute_expires_at: Date;
    }>`
      select session_id, idle_expires_at, absolute_expires_at
        from ujira.session_create(
          ${session.secretHash}, ${session.authSubject}::uuid, ${session.supabaseSessionId},
          ${session.aal}, ${session.idleSeconds}::integer, ${session.absoluteSeconds}::integer,
          ${session.ipHmac}, ${session.userAgentFamily}
        )
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('session_create returned no row');
    return {
      sessionId: row.session_id,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
    };
  },

  // The live session behind a secret. Undefined when it is revoked or expired,
  // when the membership behind it has ended, or when it never existed: a caller
  // cannot tell these apart, and has no need to.
  resolve: async (db: Tx, secretHash: Buffer): Promise<ResolvedSession | undefined> => {
    const result = await sql<{
      session_id: string;
      auth_subject: string;
      supabase_session_id: string;
      aal: string;
      principal_id: string | null;
      project_id: string | null;
      member_role: string | null;
      stepped_up_at: Date | null;
      idle_expires_at: Date;
      absolute_expires_at: Date;
    }>`
      select session_id, auth_subject, supabase_session_id, aal, principal_id, project_id,
             member_role, stepped_up_at, idle_expires_at, absolute_expires_at
        from ujira.session_resolve(${secretHash})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      sessionId: row.session_id,
      authSubject: row.auth_subject,
      supabaseSessionId: row.supabase_session_id,
      aal: row.aal,
      principalId: row.principal_id,
      projectId: row.project_id,
      memberRole: row.member_role,
      steppedUpAt: row.stepped_up_at,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
    };
  },

  // Chooses what the session acts for. False when it is refused.
  select: async (
    db: Tx,
    secretHash: Buffer,
    principalId: string,
    projectId: string | null,
  ): Promise<boolean> => {
    const result = await sql<{ selected: boolean }>`
      select ujira.session_select(${secretHash}, ${principalId}::uuid, ${projectId}::uuid) as selected
    `.execute(db);
    return result.rows[0]?.selected === true;
  },

  // The new idle expiry, or undefined when the session is not live.
  touch: async (db: Tx, secretHash: Buffer, idleSeconds: number): Promise<Date | undefined> => {
    const result = await sql<{ extended: Date | null }>`
      select ujira.session_touch(${secretHash}, ${idleSeconds}::integer) as extended
    `.execute(db);
    return result.rows[0]?.extended ?? undefined;
  },

  stepUp: async (db: Tx, secretHash: Buffer, aal: SessionAssurance): Promise<boolean> => {
    const result = await sql<{ stepped: boolean }>`
      select ujira.session_step_up(${secretHash}, ${aal}) as stepped
    `.execute(db);
    return result.rows[0]?.stepped === true;
  },

  // False when there was nothing live to revoke.
  revoke: async (db: Tx, secretHash: Buffer, reason: string): Promise<boolean> => {
    const result = await sql<{ revoked: boolean }>`
      select ujira.session_revoke(${secretHash}, ${reason}) as revoked
    `.execute(db);
    return result.rows[0]?.revoked === true;
  },

  // How many sessions it ended.
  revokeSubject: async (db: Tx, authSubject: string, reason: string): Promise<number> => {
    const result = await sql<{ revoked: string }>`
      select ujira.session_revoke_subject(${authSubject}::uuid, ${reason}) as revoked
    `.execute(db);
    return Number(result.rows[0]?.revoked ?? 0);
  },
};
