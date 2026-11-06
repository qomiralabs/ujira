// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What creating, rotating and revoking a key does. These are dashboard actions:
// the route kind has already refused an API key and checked the member's role and
// step-up by the time anything here runs.
//
// A key's whole text exists only in the response that creates it. It is not stored,
// not logged, and these routes are not written to the idempotency store, because
// that holds answers in clear.

import { API_SCOPES } from './auth.js';
import type { ApiScope, Tenant } from './auth.js';
import { ApiError } from './errors.js';
import { issueToken } from './token.js';
import type { TokenEnvironment } from './token.js';

export const API_KEY_MAX_ACTIVE = 20;
export const API_KEY_MIN_EXPIRY_DAYS = 1;
export const API_KEY_MAX_EXPIRY_DAYS = 730;
/** What the dashboard fills in. The API still requires the caller to say. */
export const API_KEY_DEFAULT_EXPIRY_DAYS = 365;
export const API_KEY_MAX_OVERLAP_HOURS = 168;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const API_KEY_PRESETS = Object.freeze({
  read_only: Object.freeze(API_SCOPES.filter((scope) => scope.endsWith(':read'))),
  payouts: Object.freeze([
    'payouts:read',
    'payouts:write',
    'recipients:read',
    'mandates:read',
    'receipts:read',
  ] satisfies ApiScope[]),
  full: API_SCOPES,
});
export type ApiKeyPreset = keyof typeof API_KEY_PRESETS;

export interface StoredApiKey {
  readonly id: string;
  /** Null only on a key made before keys had names. */
  readonly name: string | null;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly rotatedFromId: string | null;
  readonly createdAt: Date;
}

export type RotateOutcome =
  | {
      readonly outcome: 'rotated';
      readonly key: StoredApiKey;
      readonly previousExpiresAt: Date;
    }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'not_rotatable' };

/** The key rows. Each method takes the tenant, and sees nothing outside it. */
export interface ApiKeyRecords {
  /** Null when the project already holds its limit of active keys. */
  readonly create: (
    tenant: Tenant,
    key: {
      readonly name: string;
      readonly prefix: string;
      readonly secretSha256: Buffer;
      readonly scopes: readonly ApiScope[];
      readonly expiresAt: Date;
    },
    actorId: string,
  ) => Promise<StoredApiKey | null>;
  readonly rotate: (
    tenant: Tenant,
    rotation: {
      readonly id: string;
      readonly prefix: string;
      readonly secretSha256: Buffer;
      /** When the old key stops, unless it was going to stop sooner. */
      readonly overlapUntil: Date;
      readonly now: Date;
    },
    actorId: string,
  ) => Promise<RotateOutcome>;
  /** The key, revoked whether by this call or before it, or undefined if it is not here. */
  readonly revoke: (
    tenant: Tenant,
    id: string,
    actorId: string,
  ) => Promise<StoredApiKey | undefined>;
}

export interface ApiKeyServiceDeps {
  readonly records: ApiKeyRecords;
  /** The one environment this deployment issues keys for. */
  readonly environment: TokenEnvironment;
  readonly now?: () => Date;
}

export interface ApiKeyView {
  readonly principalId: string;
  readonly projectId: string;
  readonly id: string;
  readonly name: string | null;
  readonly prefix: string;
  readonly scopes: string[];
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly rotatedFromId: string | null;
  readonly createdAt: string;
}

function viewOf(tenant: Tenant, key: StoredApiKey): ApiKeyView {
  return {
    principalId: tenant.principalId,
    projectId: tenant.projectId,
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: [...key.scopes],
    expiresAt: key.expiresAt.toISOString(),
    revokedAt: key.revokedAt === null ? null : key.revokedAt.toISOString(),
    rotatedFromId: key.rotatedFromId,
    createdAt: key.createdAt.toISOString(),
  };
}

// The longest a rotated key can be given, as a rotation carries the old key's
// lifetime forward and an old key may predate the limit.
export function rotatedExpiry(
  old: { readonly createdAt: Date; readonly expiresAt: Date },
  now: Date,
): Date {
  const lifetime = old.expiresAt.getTime() - old.createdAt.getTime();
  return new Date(now.getTime() + Math.min(lifetime, API_KEY_MAX_EXPIRY_DAYS * DAY_MS));
}

function expiryOf(days: number | undefined, now: Date): Date {
  // A forced expiry is the point, so leaving it out is refused rather than
  // defaulted: the default belongs to the screen where a person can see it.
  if (days === undefined || days < API_KEY_MIN_EXPIRY_DAYS || days > API_KEY_MAX_EXPIRY_DAYS) {
    throw new ApiError('API_KEY_EXPIRY_INVALID', {
      detail: `expiresInDays is required, from ${String(API_KEY_MIN_EXPIRY_DAYS)} to ${String(API_KEY_MAX_EXPIRY_DAYS)}`,
      errors: [{ field: 'expiresInDays', code: 'invalid_value' }],
    });
  }
  return new Date(now.getTime() + days * DAY_MS);
}

export interface ApiKeyEndpoints {
  readonly create: (
    body: {
      readonly name: string;
      readonly scopes?: readonly ApiScope[] | undefined;
      readonly preset?: ApiKeyPreset | undefined;
      readonly expiresInDays?: number | undefined;
    },
    caller: { readonly tenant: Tenant; readonly actorId: string },
  ) => Promise<ApiKeyView & { readonly key: string }>;
  readonly rotate: (
    id: string,
    body: { readonly overlapHours: number },
    caller: { readonly tenant: Tenant; readonly actorId: string },
  ) => Promise<ApiKeyView & { readonly key: string; readonly previousKeyExpiresAt: string }>;
  readonly revoke: (
    id: string,
    caller: { readonly tenant: Tenant; readonly actorId: string },
  ) => Promise<ApiKeyView>;
}

export function createApiKeyEndpoints(deps: ApiKeyServiceDeps): ApiKeyEndpoints {
  const now = deps.now ?? (() => new Date());
  return {
    create: async (body, { tenant, actorId }) => {
      const at = now();
      const expiresAt = expiryOf(body.expiresInDays, at);
      const scopes = body.scopes ?? (body.preset === undefined ? [] : API_KEY_PRESETS[body.preset]);
      const issued = issueToken(deps.environment);
      const stored = await deps.records.create(
        tenant,
        {
          name: body.name,
          prefix: issued.prefix,
          secretSha256: issued.secretSha256,
          scopes,
          expiresAt,
        },
        actorId,
      );
      if (stored === null) throw new ApiError('API_KEY_LIMIT_REACHED');
      return { ...viewOf(tenant, stored), key: issued.token };
    },

    rotate: async (id, body, { tenant, actorId }) => {
      const at = now();
      const issued = issueToken(deps.environment);
      const result = await deps.records.rotate(
        tenant,
        {
          id,
          prefix: issued.prefix,
          secretSha256: issued.secretSha256,
          overlapUntil: new Date(at.getTime() + body.overlapHours * HOUR_MS),
          now: at,
        },
        actorId,
      );
      // Another tenant's id reads exactly like one that never existed.
      if (result.outcome === 'not_found') throw new ApiError('NOT_FOUND');
      if (result.outcome === 'not_rotatable') throw new ApiError('API_KEY_NOT_ROTATABLE');
      return {
        ...viewOf(tenant, result.key),
        key: issued.token,
        previousKeyExpiresAt: result.previousExpiresAt.toISOString(),
      };
    },

    revoke: async (id, { tenant, actorId }) => {
      const stored = await deps.records.revoke(tenant, id, actorId);
      if (stored === undefined) throw new ApiError('NOT_FOUND');
      return viewOf(tenant, stored);
    },
  };
}
