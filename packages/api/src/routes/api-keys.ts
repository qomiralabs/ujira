// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Creating, rotating and revoking API keys. People do this in the dashboard, with a
// fresh second factor. The route kind is what makes that so: an API key cannot reach
// these handlers, whatever it holds.

import { z } from 'zod';

import { API_KEY_MAX_OVERLAP_HOURS, API_KEY_PRESETS } from '../api-key-service.js';
import type { ApiKeyEndpoints, ApiKeyPreset } from '../api-key-service.js';
import { API_SCOPES } from '../auth.js';
import type { MemberRole } from '../auth.js';
import { ApiError } from '../errors.js';
import { defineMemberRoute } from '../route.js';
import type { Route } from '../route.js';

// Least privilege until the permission table exists: a key can move money up to
// what it holds, so making one is held to the two roles warned about its expiry.
const MANAGES_KEYS: readonly MemberRole[] = ['owner', 'admin'];

const Id = z.uuid();
const KeyParams = z.strictObject({ id: Id });

const KeyName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  // \p{Cc} is every control character, so a name cannot break a log line or a screen.
  .regex(/^\P{Cc}+$/u, 'printable text');

const PRESETS = Object.keys(API_KEY_PRESETS) as [ApiKeyPreset, ...ApiKeyPreset[]];

export const CreateApiKeyRequest = z
  .strictObject({
    name: KeyName,
    scopes: z
      .array(z.enum(API_SCOPES))
      .min(1)
      .max(10)
      .refine((scopes) => new Set(scopes).size === scopes.length, 'each scope at most once')
      .optional(),
    preset: z.enum(PRESETS).optional(),
    // Optional here so that leaving it out gets its own answer, not a shape error.
    expiresInDays: z.number().int().optional(),
  })
  .refine((body) => (body.scopes === undefined) !== (body.preset === undefined), {
    path: ['scopes'],
    message: 'scopes or a preset, not both',
  });

export const RotateApiKeyRequest = z.strictObject({
  overlapHours: z.number().int().min(0).max(API_KEY_MAX_OVERLAP_HOURS),
});

const apiKeyFields = {
  principalId: z.uuid(),
  projectId: z.uuid(),
  id: z.uuid(),
  name: z.string().nullable(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  rotatedFromId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
} as const;

export const ApiKeyView = z.strictObject(apiKeyFields);
export const ApiKeyIssued = z.strictObject({
  ...apiKeyFields,
  /** The whole key. This response is the only time anyone sees it. */
  key: z.string(),
});
export const ApiKeyRotated = z.strictObject({
  ...apiKeyFields,
  key: z.string(),
  previousKeyExpiresAt: z.iso.datetime(),
});

const notConfigured = (): Promise<never> => Promise.reject(new ApiError('DB_UNAVAILABLE'));

/** Stands in until a deployment has its stores, so no key is issued by a half built server. */
export const API_KEYS_NOT_CONFIGURED: ApiKeyEndpoints = Object.freeze({
  create: notConfigured,
  rotate: notConfigured,
  revoke: notConfigured,
});

export function apiKeyRoutes(flow: ApiKeyEndpoints): readonly Route[] {
  return [
    defineMemberRoute({
      id: 'createApiKey',
      method: 'POST',
      path: '/v1/api-keys',
      summary: 'Create an API key. The whole key is in this response and never again',
      roles: MANAGES_KEYS,
      stepUp: true,
      body: CreateApiKeyRequest,
      response: { status: 201, name: 'ApiKeyIssued', schema: ApiKeyIssued },
      errors: ['API_KEY_EXPIRY_INVALID', 'API_KEY_LIMIT_REACHED'],
      handler: ({ body }, context) =>
        flow.create(body, { tenant: context.tenant, actorId: context.member.userId }),
    }),
    defineMemberRoute({
      id: 'rotateApiKey',
      method: 'POST',
      path: '/v1/api-keys/{id}/rotate',
      summary: 'Replace an API key, with the old one working for the overlap',
      roles: MANAGES_KEYS,
      stepUp: true,
      params: KeyParams,
      body: RotateApiKeyRequest,
      response: { status: 201, name: 'ApiKeyRotated', schema: ApiKeyRotated },
      errors: ['NOT_FOUND', 'API_KEY_NOT_ROTATABLE'],
      handler: ({ params, body }, context) =>
        flow.rotate(params.id, body, { tenant: context.tenant, actorId: context.member.userId }),
    }),
    defineMemberRoute({
      id: 'revokeApiKey',
      method: 'POST',
      path: '/v1/api-keys/{id}/revoke',
      summary: 'Revoke an API key now. It stops everywhere within 30 seconds',
      roles: MANAGES_KEYS,
      stepUp: true,
      params: KeyParams,
      response: { name: 'ApiKeyView', schema: ApiKeyView },
      errors: ['NOT_FOUND'],
      handler: ({ params }, context) =>
        flow.revoke(params.id, { tenant: context.tenant, actorId: context.member.userId }),
    }),
  ];
}
