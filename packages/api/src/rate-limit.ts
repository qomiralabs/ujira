// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Rate limits per key and per principal, plus a tighter one on payout creation.
// The buckets live in the database rather than in this process, so a limit holds
// across every instance of the API.
//
// A bucket's key is a digest of what it limits, because the table sits in the
// schema that holds no customer data. The digest also means two kinds of bucket
// for one id can never collide.

import { createHash } from 'node:crypto';

import type { CallOptions, Tenant } from './auth.js';

export interface RateLimitRule {
  /** The burst: how many requests a full bucket allows at once. */
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateLimitRules {
  readonly token: RateLimitRule;
  readonly principal: RateLimitRule;
  readonly payoutCreation: RateLimitRule;
}

export const RATE_LIMIT_DEFAULTS: RateLimitRules = Object.freeze({
  token: Object.freeze({ capacity: 40, refillPerSecond: 20 }),
  principal: Object.freeze({ capacity: 100, refillPerSecond: 50 }),
  payoutCreation: Object.freeze({ capacity: 10, refillPerSecond: 10 }),
});

/** A tighter limit a route opts into on top of the ones every tenant route has. */
export type RateLimitGroup = 'payout_creation';

export interface RateLimitSubject {
  readonly tenant: Tenant;
  readonly tokenId: string;
  readonly group: RateLimitGroup | null;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the tightest bucket is full again. */
  readonly resetSeconds: number;
  /** Seconds until a retry can succeed; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

export type RateLimit = (
  subject: RateLimitSubject,
  call: CallOptions,
) => Promise<RateLimitDecision>;

export interface BucketRequest {
  readonly key: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface BucketResult {
  readonly key: string;
  readonly allowed: boolean;
  readonly tokens: number;
}

export interface BucketStore {
  /**
   * Refills the buckets and takes one token from each, all or none, as one
   * upsert per request. All or none, so a key spamming past its own limit does
   * not drain its principal's bucket and starve the principal's other keys.
   */
  readonly take: (
    buckets: readonly BucketRequest[],
    call: CallOptions,
  ) => Promise<readonly BucketResult[]>;
}

/** For tests, and for a server that refuses every key and so never asks. */
export const allowEveryRequest: RateLimit = () =>
  Promise.resolve({ allowed: true, limit: 0, remaining: 0, resetSeconds: 0, retryAfterSeconds: 0 });

export function bucketKey(kind: 'token' | 'principal' | 'payout_creation', id: string): string {
  const digest = createHash('sha256').update(`${kind}:${id}`, 'utf8').digest('hex');
  return `${kind}:${digest}`;
}

function bucketsFor(
  subject: RateLimitSubject,
  rules: RateLimitRules,
): [BucketRequest, ...BucketRequest[]] {
  const { principalId } = subject.tenant;
  const others: BucketRequest[] = [
    { key: bucketKey('principal', principalId), ...rules.principal },
  ];
  if (subject.group === 'payout_creation') {
    others.push({ key: bucketKey('payout_creation', principalId), ...rules.payoutCreation });
  }
  return [{ key: bucketKey('token', subject.tokenId), ...rules.token }, ...others];
}

function secondsUntil(tokensNeeded: number, refillPerSecond: number): number {
  return Math.max(Math.ceil(tokensNeeded / refillPerSecond), 0);
}

interface Reading {
  readonly bucket: BucketRequest;
  readonly tokens: number;
}

export function createRateLimit(
  store: BucketStore,
  rules: RateLimitRules = RATE_LIMIT_DEFAULTS,
): RateLimit {
  return async (subject, call) => {
    const [first, ...others] = bucketsFor(subject, rules);
    const results = await store.take([first, ...others], call);
    const tokensOf = new Map(results.map((result) => [result.key, result.tokens]));
    const read = (bucket: BucketRequest): Reading => ({
      bucket,
      tokens: tokensOf.get(bucket.key) ?? 0,
    });
    // A store that answers for fewer buckets than it was asked about has not
    // said yes to all of them.
    const allowed =
      results.length === others.length + 1 && results.every((result) => result.allowed);
    // The bucket that decides what the client is told: when refused, the one that
    // takes longest to allow a retry; when allowed, the one nearest to refusing.
    const score = ({ bucket, tokens }: Reading): number =>
      allowed ? -Math.floor(tokens) : (1 - tokens) / bucket.refillPerSecond;
    const { bucket, tokens } = others
      .map(read)
      .reduce((best, reading) => (score(reading) > score(best) ? reading : best), read(first));
    return {
      allowed,
      limit: bucket.capacity,
      remaining: Math.max(Math.floor(tokens), 0),
      resetSeconds: secondsUntil(bucket.capacity - tokens, bucket.refillPerSecond),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(secondsUntil(1 - tokens, bucket.refillPerSecond), 1),
    };
  };
}

/** The headers every rate limited response carries. */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    'ratelimit-limit': String(decision.limit),
    'ratelimit-remaining': String(decision.remaining),
    'ratelimit-reset': String(decision.resetSeconds),
  };
}
