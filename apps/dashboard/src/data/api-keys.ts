// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The API key routes, as the API publishes them: create, rotate and revoke,
// which need a person with a fresh second factor, and the list the screen
// reads. Every answer is parsed here before a screen sees it.
//
// A new key's whole text arrives in exactly one answer, the one that creates
// or rotates it. The list never carries it.

import { z } from 'zod';

import type { DataClient } from './client';

export const API_SCOPES = [
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
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_KEY_PRESETS = {
  read_only: API_SCOPES.filter((scope) => scope.endsWith(':read')),
  payouts: ['payouts:read', 'payouts:write', 'recipients:read', 'mandates:read', 'receipts:read'],
  full: [...API_SCOPES],
} as const satisfies Record<string, readonly ApiScope[]>;
export type ApiKeyPreset = keyof typeof API_KEY_PRESETS;
export const API_KEY_PRESET_IDS = Object.keys(API_KEY_PRESETS) as [ApiKeyPreset, ...ApiKeyPreset[]];

export const API_KEY_MIN_EXPIRY_DAYS = 1;
export const API_KEY_MAX_EXPIRY_DAYS = 730;
/** The API needs an expiry; this is the one the screen fills in. */
export const API_KEY_DEFAULT_EXPIRY_DAYS = 365;
export const API_KEY_MAX_ACTIVE = 20;
export const API_KEY_MAX_OVERLAP_HOURS = 168;
export const API_KEY_NAME_MAX = 100;

const Uuid = z.uuid();
const Timestamp = z.iso.datetime();

/** What a person calls a key. Control characters would break a log line or a screen. */
export const ApiKeyName = z
  .string()
  .trim()
  .min(1)
  .max(API_KEY_NAME_MAX)
  .regex(/^\P{Cc}+$/u);

// `ujk_<env>_<id>`, the public part that names a key.
const KeyPrefix = z.string().regex(/^ujk_(live|test)_[a-z2-7]{16}$/);
// The prefix, the secret and its checksum.
const KeyText = z.string().regex(/^ujk_(live|test)_[a-z2-7]{16}_[a-z2-7]{59}$/);

const viewFields = {
  principalId: Uuid,
  projectId: Uuid,
  id: Uuid,
  /** Null only on a key made before keys had names. */
  name: z.string().nullable(),
  prefix: KeyPrefix,
  // Plain strings: a scope added to the API later must not break the list.
  scopes: z.array(z.string()),
  expiresAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  rotatedFromId: Uuid.nullable(),
  createdAt: Timestamp,
};

export const ApiKeyView = z.strictObject(viewFields);
export type ApiKeyView = z.infer<typeof ApiKeyView>;

export const ApiKeyListItem = z.strictObject({
  ...viewFields,
  /** Accurate to about five minutes. Null for a key never used. */
  lastUsedAt: Timestamp.nullable(),
});
export type ApiKeyListItem = z.infer<typeof ApiKeyListItem>;

const keyMatchesPrefix = (value: { key: string; prefix: string }) =>
  value.key.startsWith(`${value.prefix}_`);

export const ApiKeyIssued = z
  .strictObject({ ...viewFields, key: KeyText })
  .refine(keyMatchesPrefix, { path: ['key'] });
export type ApiKeyIssued = z.infer<typeof ApiKeyIssued>;

export const ApiKeyRotated = z
  .strictObject({ ...viewFields, key: KeyText, previousKeyExpiresAt: Timestamp })
  .refine(keyMatchesPrefix, { path: ['key'] });
export type ApiKeyRotated = z.infer<typeof ApiKeyRotated>;

const Cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ApiKeyPage = z.strictObject({
  items: z.array(ApiKeyListItem),
  nextCursor: Cursor.nullable(),
});
export type ApiKeyPage = z.infer<typeof ApiKeyPage>;

const Scopes = z
  .array(z.enum(API_SCOPES))
  .min(1)
  .max(API_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length);

export const CreateApiKeyRequest = z.union([
  z.strictObject({ name: ApiKeyName, scopes: Scopes, expiresInDays: z.number().int() }),
  z.strictObject({
    name: ApiKeyName,
    preset: z.enum(API_KEY_PRESET_IDS),
    expiresInDays: z.number().int(),
  }),
]);
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export const RotateApiKeyRequest = z.strictObject({
  overlapHours: z.number().int().min(0).max(API_KEY_MAX_OVERLAP_HOURS),
});

export interface ListOptions {
  cursor?: string | undefined;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}

export function apiKeysApi(client: DataClient) {
  return {
    list(project: string, options: ListOptions = {}): Promise<ApiKeyPage> {
      return client.request({
        method: 'GET',
        path: '/v1/api-keys',
        project,
        query: {
          cursor: options.cursor,
          limit: options.limit === undefined ? undefined : String(options.limit),
        },
        schema: ApiKeyPage,
        signal: options.signal,
      });
    },

    create(project: string, body: CreateApiKeyRequest): Promise<ApiKeyIssued> {
      return client.request({
        method: 'POST',
        path: '/v1/api-keys',
        project,
        body,
        schema: ApiKeyIssued,
      });
    },

    rotate(project: string, id: string, overlapHours: number): Promise<ApiKeyRotated> {
      return client.request({
        method: 'POST',
        path: `/v1/api-keys/${encodeURIComponent(id)}/rotate`,
        project,
        body: { overlapHours },
        schema: ApiKeyRotated,
      });
    },

    revoke(project: string, id: string): Promise<ApiKeyView> {
      return client.request({
        method: 'POST',
        path: `/v1/api-keys/${encodeURIComponent(id)}/revoke`,
        project,
        schema: ApiKeyView,
      });
    },
  };
}

export type ApiKeysApi = ReturnType<typeof apiKeysApi>;
