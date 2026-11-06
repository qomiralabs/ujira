// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The token and rate limit ports over the database package. Thin on purpose:
// every query lives in that package's repositories, and the time limit on each
// comes from the statement and lock timeouts every transaction opens with.

import { apiTokens, embedSessions, entryPoints, rateLimits, recipients } from '@ujira/db';
import type { Database } from '@ujira/db';

import type { BucketStore } from './rate-limit.js';
import type { EmbedStore } from './routes/embed.js';
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

export function databaseEmbedStore(db: Database): EmbedStore {
  return {
    // Before a tenant is known, so these run through the entry points that can.
    find: (secretSha256) =>
      db.unscoped((tx) => entryPoints.authenticateEmbedToken(tx, secretSha256)),
    exchange: (swap) => db.unscoped((tx) => entryPoints.exchangeEmbedInvite(tx, swap)),
    recipientExists: async (tenant, recipientId) =>
      (await db.tenant(tenant).transaction((tx) => recipients.get(tx, recipientId))) !== undefined,
    create: async (tenant, row) => {
      await db.tenant(tenant).transaction((tx) =>
        embedSessions.create(tx, {
          kind: row.kind,
          tokenHash: row.secretSha256,
          tokenPrefix: row.prefix,
          recipientId: row.recipientId,
          purpose: row.purpose,
          allowedOrigins: row.allowedOrigins,
          createdByToken: row.createdByToken,
          expiresAt: row.expiresAt,
        }),
      );
    },
  };
}

export function databaseBucketStore(db: Database): BucketStore {
  return {
    take: (buckets) => db.unscoped((tx) => rateLimits.take(tx, buckets)),
  };
}
