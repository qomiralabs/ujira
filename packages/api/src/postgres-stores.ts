// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The token, rate limit and key lifecycle ports over the database package. Thin on purpose:
// every query lives in that package's repositories, and the time limit on each
// comes from the statement and lock timeouts every transaction opens with.

import { apiTokenWarnings, apiTokens, audit, entryPoints, rateLimits } from '@ujira/db';
import type { ApiToken, Database } from '@ujira/db';

import { API_KEY_MAX_ACTIVE, rotatedExpiry } from './api-key-service.js';
import type { ApiKeyRecords, StoredApiKey } from './api-key-service.js';
import type { ApiKeyWarningRecords } from './api-key-warnings.js';
import type { BucketStore } from './rate-limit.js';
import type { TokenStore } from './token-auth.js';

export function databaseTokenStore(db: Database): TokenStore {
  return {
    // Before a tenant is known, so it runs through the one entry point that can.
    find: (prefix) => db.unscoped((tx) => entryPoints.authenticateToken(tx, prefix)),
    // The tenant comes from the row just found, never from the request.
    touchLastUsed: async (tenant, tokenId) => {
      await db.tenant(tenant).transaction((tx) => apiTokens.touchLastUsed(tx, tokenId));
    },
  };
}

export function databaseBucketStore(db: Database): BucketStore {
  return {
    take: (buckets) => db.unscoped((tx) => rateLimits.take(tx, buckets)),
  };
}

function storedKeyOf(token: ApiToken): StoredApiKey {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    rotatedFromId: token.rotatedFromId,
    createdAt: token.createdAt,
  };
}

// The key's id and that it is a key. Its name is a person's words, and the audit
// log keeps only what it needs.
function auditTarget(id: string): { readonly target_type: string; readonly target_id: string } {
  return { target_type: 'api_key', target_id: id };
}

export function databaseApiKeyRecords(db: Database): ApiKeyRecords {
  return {
    create: (tenant, key, actorId) =>
      db.tenant(tenant).transaction(async (tx) => {
        const created = await apiTokens.createWithinLimit(tx, key, API_KEY_MAX_ACTIVE);
        if (created === undefined) return null;
        await audit.record(tx, {
          action: 'api_key.created',
          actor: { kind: 'member', id: actorId },
          metadata: auditTarget(created.id),
        });
        return storedKeyOf(created);
      }),

    rotate: (tenant, rotation, actorId) =>
      db.tenant(tenant).transaction(async (tx) => {
        const old = await apiTokens.get(tx, rotation.id);
        if (old === undefined) return { outcome: 'not_found' as const };
        if (old.revokedAt !== null || old.expiresAt.getTime() <= rotation.now.getTime()) {
          return { outcome: 'not_rotatable' as const };
        }
        const next = await apiTokens.createSuccessor(tx, {
          ...(old.name === null ? {} : { name: old.name }),
          prefix: rotation.prefix,
          secretSha256: rotation.secretSha256,
          scopes: old.scopes,
          expiresAt: rotatedExpiry(old, rotation.now),
          rotatedFromId: old.id,
        });
        // This key has been rotated already, or another request just did it.
        if (next === undefined) return { outcome: 'not_rotatable' as const };
        const previousExpiresAt = await apiTokens.shortenExpiry(tx, old.id, rotation.overlapUntil);
        await audit.record(tx, {
          action: 'api_key.rotated',
          actor: { kind: 'member', id: actorId },
          metadata: auditTarget(old.id),
        });
        return {
          outcome: 'rotated' as const,
          key: storedKeyOf(next),
          previousExpiresAt: previousExpiresAt ?? old.expiresAt,
        };
      }),

    revoke: (tenant, id, actorId) =>
      db.tenant(tenant).transaction(async (tx) => {
        const revoked = await apiTokens.revoke(tx, id);
        if (revoked) {
          await audit.record(tx, {
            action: 'api_key.revoked',
            actor: { kind: 'member', id: actorId },
            metadata: auditTarget(id),
          });
        }
        const token = await apiTokens.get(tx, id);
        return token === undefined ? undefined : storedKeyOf(token);
      }),
  };
}

export function databaseApiKeyWarningRecords(db: Database): ApiKeyWarningRecords {
  return {
    targets: (after, limit) =>
      db.unscoped((tx) => entryPoints.apiTokensNearingExpiry(tx, after, limit)),
    key: (target) =>
      db.tenant(target).transaction(async (tx) => {
        const token = await apiTokens.get(tx, target.tokenId);
        return token === undefined
          ? undefined
          : {
              prefix: token.prefix,
              name: token.name,
              expiresAt: token.expiresAt,
              revokedAt: token.revokedAt,
            };
      }),
    claim: (target, thresholdDays, claimSeconds) =>
      db
        .tenant(target)
        .transaction((tx) =>
          apiTokenWarnings.claim(tx, { tokenId: target.tokenId, thresholdDays, claimSeconds }),
        ),
    markNotified: (target, thresholds) =>
      db.tenant(target).transaction(async (tx) => {
        for (const thresholdDays of thresholds) {
          await apiTokenWarnings.markNotified(tx, { tokenId: target.tokenId, thresholdDays });
        }
      }),
  };
}
