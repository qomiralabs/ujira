// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Token authentication, in the order that spends the least on a bad request:
// the browser origin, the header, the format and checksum, and the key's
// environment are all checked in memory, so none of those failures reaches the
// database. Then the prefix is looked up and the secret's hash compared in
// constant time. Unknown, wrong secret, expired and revoked keys all read the
// same to the caller, and take the same path, so the answer tells nothing about
// which prefixes exist.
//
// A good lookup is cached for at most 30 seconds, so a key revoked elsewhere
// stops working within that time on every instance. A hit still has its secret
// compared, because the cache is keyed by the public prefix.

import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { API_SCOPES } from './auth.js';
import type {
  ApiScope,
  AuthFailureCode,
  AuthResult,
  Authenticate,
  CallOptions,
  Tenant,
} from './auth.js';
import { errorNameOf, requestLog } from './log.js';
import type { Logger } from './log.js';
import { hashSecret, parseToken } from './token.js';
import type { TokenEnvironment } from './token.js';

/** What the store knows about a key. The secret itself is never in it. */
export interface TokenLookup {
  readonly tokenId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly secretSha256: Buffer;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface TokenStore {
  /** The key the prefix names, whatever its tenant, or undefined. */
  readonly find: (prefix: string, call: CallOptions) => Promise<TokenLookup | undefined>;
  /** Records use of a key, at most once per five minutes however often it is called. */
  readonly touchLastUsed: (tenant: Tenant, tokenId: string, call: CallOptions) => Promise<void>;
}

export interface TokenAuthOptions {
  readonly store: TokenStore;
  /** The one environment whose keys this deployment accepts. */
  readonly environment: TokenEnvironment;
  /** Exact origins a browser may send a key from. Anything else with an Origin is refused. */
  readonly embedOrigins: readonly string[];
  readonly logger: Logger;
  readonly now?: () => Date;
  /** Capped at the 30 second limit, so a setting cannot stretch how long a revoked key lives. */
  readonly cacheTtlMs?: number;
  readonly cacheMaxEntries?: number;
}

/** A stored key holds scopes this code does not know. The check constraint makes that a bug. */
export class TokenRecordError extends Error {
  override readonly name = 'TokenRecordError';
}

export const TOKEN_CACHE_MAX_TTL_MS = 30_000;
const DEFAULT_CACHE_ENTRIES = 10_000;

const BEARER = /^Bearer (\S+)$/i;
const SHA256_BYTES = 32;

// Compared against when no key was found, so an unknown prefix costs what a
// wrong secret costs. No secret hashes to this.
const NO_SECRET = Buffer.alloc(SHA256_BYTES);

const StoredScopes = z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length);

interface Cached {
  readonly lookup: TokenLookup;
  readonly scopes: readonly ApiScope[];
  readonly cachedAt: number;
}

function refused(code: AuthFailureCode): AuthResult {
  return { ok: false, code };
}

function secretMatches(secret: string, stored: Buffer | undefined): boolean {
  const presented = hashSecret(secret);
  // A hash of the wrong length cannot have come from a valid row; the compare
  // would throw on it, so it fails like any other mismatch.
  const against = stored?.length === SHA256_BYTES ? stored : NO_SECRET;
  return timingSafeEqual(presented, against) && stored !== undefined;
}

function scopesOf(lookup: TokenLookup): readonly ApiScope[] {
  const parsed = StoredScopes.safeParse(lookup.scopes);
  if (!parsed.success) throw new TokenRecordError('a stored key holds scopes this code refuses');
  return parsed.data;
}

export function createTokenAuthenticator(options: TokenAuthOptions): Authenticate {
  const now = options.now ?? (() => new Date());
  const ttlMs = Math.min(options.cacheTtlMs ?? TOKEN_CACHE_MAX_TTL_MS, TOKEN_CACHE_MAX_TTL_MS);
  const maxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_ENTRIES;
  const origins: ReadonlySet<string> = new Set(options.embedOrigins);
  const cache = new Map<string, Cached>();

  const remember = (prefix: string, entry: Cached): void => {
    // Oldest first, since a Map keeps insertion order. Filling up only costs a
    // lookup, and the bound keeps one process from holding every key ever seen.
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(prefix, entry);
  };

  const fresh = (prefix: string, at: number): Cached | undefined => {
    const entry = cache.get(prefix);
    if (entry === undefined) return undefined;
    if (at - entry.cachedAt < ttlMs) return entry;
    cache.delete(prefix);
    return undefined;
  };

  const touch = async (tenant: Tenant, tokenId: string, call: CallOptions): Promise<void> => {
    try {
      await options.store.touchLastUsed(tenant, tokenId, call);
    } catch (error) {
      // A missed timestamp must not refuse a valid key. It is logged, and the
      // next lookup tries again.
      requestLog(options.logger, call.correlationId, now).warn('token_touch_failed', {
        ...tenant,
        errorName: errorNameOf(error),
      });
    }
  };

  return async (credentials, call) => {
    if (credentials.origin !== null && !origins.has(credentials.origin)) {
      return refused('ORIGIN_NOT_ALLOWED');
    }
    const presented = BEARER.exec(credentials.authorization ?? '')?.[1];
    const parsed = presented === undefined ? null : parseToken(presented);
    if (parsed === null) return refused('TOKEN_MALFORMED');
    if (parsed.environment !== options.environment) return refused('TOKEN_ENVIRONMENT_MISMATCH');

    const at = now().getTime();
    const cached = fresh(parsed.prefix, at);
    const lookup = cached?.lookup ?? (await options.store.find(parsed.prefix, call));

    // Every check runs whichever failed, so the time taken says nothing either.
    const secretOk = secretMatches(parsed.secret, lookup?.secretSha256);
    const live = lookup?.revokedAt === null && lookup.expiresAt.getTime() > at;
    if (lookup === undefined || !secretOk || !live) return refused('TOKEN_INVALID');

    const tenant: Tenant = { principalId: lookup.principalId, projectId: lookup.projectId };
    const scopes = cached?.scopes ?? scopesOf(lookup);
    if (cached === undefined) {
      remember(parsed.prefix, { lookup, scopes, cachedAt: at });
      await touch(tenant, lookup.tokenId, call);
    }
    return { ok: true, tenant: { ...tenant, tokenId: lookup.tokenId, scopes } };
  };
}
