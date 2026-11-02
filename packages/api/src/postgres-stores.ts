// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The token and rate limit ports over the database package. Thin on purpose:
// every query lives in that package's repositories, and the time limit on each
// comes from the statement and lock timeouts every transaction opens with.

import { apiTokens, entryPoints, idempotencyKeys, rateLimits, securityEvents } from '@ujira/db';
import type { Database } from '@ujira/db';

import type { IdempotencyStore } from './idempotency.js';
import type { BucketStore } from './rate-limit.js';
import type { SecurityEventSink, TokenStore } from './token-auth.js';

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

export function databaseSecurityEvents(db: Database): SecurityEventSink {
  // Unscoped, because a refused key has no tenant anyone can trust.
  return (event) => db.unscoped((tx) => securityEvents.record(tx, event));
}

export function databaseIdempotencyStore(db: Database): IdempotencyStore {
  return {
    reserve: (tenant, request) =>
      db.tenant(tenant).transaction((tx) => idempotencyKeys.reserve(tx, request)),
    complete: (tenant, request) =>
      db.tenant(tenant).transaction((tx) => idempotencyKeys.complete(tx, request)),
    release: (tenant, request) =>
      db.tenant(tenant).transaction((tx) => idempotencyKeys.release(tx, request)),
  };
}

export function databaseBucketStore(db: Database): BucketStore {
  return {
    take: (buckets) => db.unscoped((tx) => rateLimits.take(tx, buckets)),
  };
}
