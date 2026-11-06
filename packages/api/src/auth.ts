// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The seam between the request pipeline and whatever proves who is calling.
// The pipeline hands the authenticator the two headers it needs and nothing
// else, so the tenant can only ever come from the credential, never from a
// path, a query or a body.

import { z } from 'zod';

/** The closed list of scopes a key can hold. Every tenant route names one. */
export const API_SCOPES = Object.freeze([
  'payouts:read',
  'payouts:write',
  'approvals:write',
  'recipients:read',
  'recipients:write',
  'mandates:read',
  'mandates:write',
  'receipts:read',
  'webhooks:manage',
  'corridors:read',
] as const);
export type ApiScope = (typeof API_SCOPES)[number];

/** The tenant a request runs as. */
export interface Tenant {
  readonly principalId: string;
  readonly projectId: string;
}

export interface AuthenticatedTenant extends Tenant {
  /** Which key this is, for its own rate limit. Never sent to a client. */
  readonly tokenId: string;
  readonly scopes: readonly ApiScope[];
}

/** A person, from a dashboard session, as opposed to a key. */
export const MEMBER_ROLES = Object.freeze(['owner', 'admin', 'developer', 'viewer'] as const);
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface AuthenticatedMember extends Tenant {
  readonly userId: string;
  readonly role: MemberRole;
  /** When this session last passed a second factor, or null if it never has. */
  readonly steppedUpAt: Date | null;
}

export type MemberAuthResult =
  | { readonly ok: true; readonly member: AuthenticatedMember }
  | { readonly ok: false; readonly code: 'TOKEN_INVALID' | 'ORIGIN_NOT_ALLOWED' };

export interface MemberCredentials extends Credentials {
  /** The Cookie header as sent, or null. */
  readonly cookie: string | null;
}

export type AuthenticateMember = (
  credentials: MemberCredentials,
  call: CallOptions,
) => Promise<MemberAuthResult>;

/** How old a second factor may be for an action that needs a fresh one. */
export const STEP_UP_MAX_AGE_SECONDS = 300;

export type AuthFailureCode =
  'TOKEN_MALFORMED' | 'TOKEN_INVALID' | 'TOKEN_ENVIRONMENT_MISMATCH' | 'ORIGIN_NOT_ALLOWED';

export type AuthResult =
  | { readonly ok: true; readonly tenant: AuthenticatedTenant }
  | { readonly ok: false; readonly code: AuthFailureCode };

export interface Credentials {
  /** The Authorization header as sent, or null. */
  readonly authorization: string | null;
  /** The Origin header as sent, or null. */
  readonly origin: string | null;
}

export interface CallOptions {
  /** Aborts at the request deadline. */
  readonly signal: AbortSignal;
  /** The request id, carried into every call so logs line up. */
  readonly correlationId: string;
}

export type Authenticate = (credentials: Credentials, call: CallOptions) => Promise<AuthResult>;

/**
 * Refuses every credential. What a local run with no database uses, so a tenant
 * route can never run as nobody.
 */
export const refuseAllCredentials: Authenticate = () =>
  Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });

/** Until dashboard sessions exist, no member route can run as anybody. */
export const refuseAllMembers: AuthenticateMember = () =>
  Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });

// Lower case canonical UUIDs only, the spelling the database accepts for a
// tenant context, so a tenant the database would refuse is refused here.
const TenantId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const AuthenticatedMemberSchema = z.strictObject({
  principalId: TenantId,
  projectId: TenantId,
  userId: TenantId,
  role: z.enum(MEMBER_ROLES),
  steppedUpAt: z.date().nullable(),
});

export const AuthenticatedTenantSchema = z.strictObject({
  principalId: TenantId,
  projectId: TenantId,
  tokenId: TenantId,
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
});
