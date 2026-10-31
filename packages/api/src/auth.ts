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
  readonly scopes: readonly ApiScope[];
}

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
 * Refuses every credential. The default until token authentication lands,
 * so a tenant route can never run as nobody.
 */
export const refuseAllCredentials: Authenticate = () =>
  Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });

// Lower case canonical UUIDs only, the spelling the database accepts for a
// tenant context, so a tenant the database would refuse is refused here.
const TenantId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const AuthenticatedTenantSchema = z.strictObject({
  principalId: TenantId,
  projectId: TenantId,
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
});
