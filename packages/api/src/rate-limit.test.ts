// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The arithmetic and the headers with a fake store, then the limits end to end
// against a real database through two separate API instances, which is the only
// way to show a limit is not per process.

import { randomUUID } from 'node:crypto';

import { Problem } from '@ujira/api-schema';
import { DatabaseUnavailableError, apiTokens, entryPoints } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import type { Authenticate, CallOptions, Tenant } from './auth.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { databaseBucketStore, databaseTokenStore } from './postgres-stores.js';
import { bucketKey, createRateLimit, RATE_LIMIT_DEFAULTS, rateLimitHeaders } from './rate-limit.js';
import type {
  BucketRequest,
  BucketResult,
  BucketStore,
  RateLimit,
  RateLimitRules,
} from './rate-limit.js';
import { defineTenantRoute } from './route.js';
import { issueToken } from './token.js';
import { createTokenAuthenticator } from './token-auth.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const TENANT: Tenant = { principalId: randomUUID(), projectId: randomUUID() };
const CALL: CallOptions = { signal: new AbortController().signal, correlationId: 'req_test' };

function fakeStore(tokensByKind: Partial<Record<string, number>> = {}, allowed = true) {
  const asked: (readonly BucketRequest[])[] = [];
  const store: BucketStore = {
    take: (buckets) => {
      asked.push(buckets);
      const results: BucketResult[] = buckets.map((bucket) => ({
        key: bucket.key,
        allowed,
        tokens: tokensByKind[bucket.key.split(':')[0] ?? ''] ?? bucket.capacity - 1,
      }));
      return Promise.resolve(results);
    },
  };
  return { store, asked };
}

describe('the defaults', () => {
  it('are the published limits', () => {
    expect(RATE_LIMIT_DEFAULTS).toEqual({
      token: { capacity: 40, refillPerSecond: 20 },
      principal: { capacity: 100, refillPerSecond: 50 },
      payoutCreation: { capacity: 10, refillPerSecond: 10 },
    });
  });
});

describe('bucket keys', () => {
  it('are digests, so no tenant id reaches the schema that holds no customer data', () => {
    const key = bucketKey('principal', TENANT.principalId);
    expect(key).toMatch(/^principal:[0-9a-f]{64}$/);
    expect(key).not.toContain(TENANT.principalId);
  });

  it('differ by kind for the same id', () => {
    expect(bucketKey('principal', 'x').split(':')[1]).not.toBe(
      bucketKey('payout_creation', 'x').split(':')[1],
    );
  });
});

describe('createRateLimit', () => {
  it('asks for the key and principal buckets on an ordinary route', async () => {
    const { store, asked } = fakeStore();
    await createRateLimit(store)({ tenant: TENANT, tokenId: 'token-1', group: null }, CALL);
    expect(asked[0]).toEqual([
      { key: bucketKey('token', 'token-1'), capacity: 40, refillPerSecond: 20 },
      { key: bucketKey('principal', TENANT.principalId), capacity: 100, refillPerSecond: 50 },
    ]);
  });

  it('adds the payout creation bucket, per principal, on a route that opts in', async () => {
    const { store, asked } = fakeStore();
    await createRateLimit(store)(
      { tenant: TENANT, tokenId: 'token-1', group: 'payout_creation' },
      CALL,
    );
    expect(asked[0]?.[2]).toEqual({
      key: bucketKey('payout_creation', TENANT.principalId),
      capacity: 10,
      refillPerSecond: 10,
    });
  });

  it('reports the bucket nearest to refusing when allowed', async () => {
    const { store } = fakeStore({ token: 39, principal: 4.5 });
    const decision = await createRateLimit(store)(
      { tenant: TENANT, tokenId: 't', group: null },
      CALL,
    );
    expect(decision).toEqual({
      allowed: true,
      limit: 100,
      remaining: 4,
      // (100 - 4.5) / 50 per second.
      resetSeconds: 2,
      retryAfterSeconds: 0,
    });
  });

  it('reports the bucket that takes longest to recover when refused', async () => {
    const { store } = fakeStore({ token: 0.5, principal: 0 }, false);
    const decision = await createRateLimit(store)(
      { tenant: TENANT, tokenId: 't', group: null },
      CALL,
    );
    // 0.5 tokens at 20 per second takes 25 ms; one token at 50 per second, 20 ms.
    expect(decision).toMatchObject({ allowed: false, limit: 40, remaining: 0 });
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('never asks a refused client to retry in no time', async () => {
    const rules: RateLimitRules = {
      token: { capacity: 2, refillPerSecond: 1 },
      principal: { capacity: 100, refillPerSecond: 50 },
      payoutCreation: { capacity: 10, refillPerSecond: 10 },
    };
    const { store } = fakeStore({ token: 1 }, false);
    const decision = await createRateLimit(store, rules)(
      { tenant: TENANT, tokenId: 't', group: null },
      CALL,
    );
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('refuses when the store answers for fewer buckets than it was asked for', async () => {
    const store: BucketStore = { take: () => Promise.resolve([]) };
    const decision = await createRateLimit(store)(
      { tenant: TENANT, tokenId: 't', group: null },
      CALL,
    );
    expect(decision.allowed).toBe(false);
  });

  it('lets a store failure through, so an outage is answered and not ignored', async () => {
    const store: BucketStore = { take: () => Promise.reject(new Error('down')) };
    await expect(
      createRateLimit(store)({ tenant: TENANT, tokenId: 't', group: null }, CALL),
    ).rejects.toThrow('down');
  });
});

describe('rateLimitHeaders', () => {
  it('names the limit, what is left and when it resets', () => {
    expect(
      rateLimitHeaders({
        allowed: true,
        limit: 40,
        remaining: 39,
        resetSeconds: 1,
        retryAfterSeconds: 0,
      }),
    ).toEqual({ 'ratelimit-limit': '40', 'ratelimit-remaining': '39', 'ratelimit-reset': '1' });
  });
});

const Body = z.strictObject({ ok: z.literal(true) });

const readRoute = defineTenantRoute({
  id: 'readThing',
  method: 'GET',
  path: '/v1/things',
  summary: 'Read',
  scope: 'payouts:read',
  response: { name: 'Thing', schema: Body },
  handler: () => Promise.resolve({ ok: true as const }),
});

const createPayout = defineTenantRoute({
  id: 'createPayout',
  method: 'POST',
  path: '/v1/payouts',
  summary: 'Create',
  scope: 'payouts:write',
  rateLimit: 'payout_creation',
  response: { status: 201, name: 'Thing', schema: Body },
  handler: () => Promise.resolve({ ok: true as const }),
});

describe('in the pipeline', () => {
  const authenticate: Authenticate = () =>
    Promise.resolve({
      ok: true,
      tenant: { ...TENANT, tokenId: randomUUID(), scopes: ['payouts:read'] },
    });

  function appWith(rateLimit: RateLimit) {
    const logger = memoryLogger();
    return createApp({
      routes: [readRoute, createPayout],
      authenticate,
      rateLimit,
      idempotency: memoryIdempotencyStore(),
      logger,
    });
  }

  it('sends the headers on a success', async () => {
    const { store } = fakeStore();
    const response = await appWith(createRateLimit(store)).request('/v1/things');
    expect(response.status).toBe(200);
    expect(response.headers.get('ratelimit-limit')).toBe('40');
    expect(response.headers.get('ratelimit-remaining')).toBe('39');
    expect(response.headers.get('ratelimit-reset')).toBe('1');
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('answers 429 RATE_LIMITED with Retry-After and the headers', async () => {
    const { store } = fakeStore({ token: 0, principal: 50 }, false);
    const response = await appWith(createRateLimit(store)).request('/v1/things');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.headers.get('ratelimit-remaining')).toBe('0');
    expect(Problem.parse(await response.json()).code).toBe('RATE_LIMITED');
  });

  it('counts a request that goes on to fail its scope check, so probing costs too', async () => {
    const { store, asked } = fakeStore();
    const response = await appWith(createRateLimit(store)).request('/v1/payouts', {
      method: 'POST',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('ratelimit-limit')).not.toBeNull();
    expect(asked).toHaveLength(1);
  });

  it('spends nothing on a request with no valid key', async () => {
    const { store, asked } = fakeStore();
    const app = createApp({
      routes: [readRoute],
      authenticate: () => Promise.resolve({ ok: false, code: 'TOKEN_MALFORMED' }),
      rateLimit: createRateLimit(store),
      idempotency: memoryIdempotencyStore(),
      logger: memoryLogger(),
    });
    expect((await app.request('/v1/things')).status).toBe(401);
    expect(asked).toEqual([]);
  });

  it('answers 503 when the buckets cannot be reached, rather than letting it through', async () => {
    const store: BucketStore = {
      take: () => Promise.reject(new DatabaseUnavailableError('ECONNREFUSED')),
    };
    const response = await appWith(createRateLimit(store)).request('/v1/things');
    expect(response.status).toBe(503);
    expect(Problem.parse(await response.json()).code).toBe('DB_UNAVAILABLE');
  });
});

describe('against the database', () => {
  const adminUrl = inject('dbAdminUrl');
  const roleUrls = inject('dbRoleUrls');

  let database: TestDatabase;
  // Two pools and two authenticators, as two instances of the API would have.
  let first: Database;
  let second: Database;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl, import.meta.url);
    first = databaseAsServiceRoles(roleUrls, database);
    second = databaseAsServiceRoles(roleUrls, database);
  });

  afterAll(async () => {
    await first.close();
    await second.close();
    await database.drop();
  });

  async function newTenant(): Promise<Tenant> {
    return first.unscoped((tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'Limited',
        projectName: 'Main',
        ownerUserId: randomUUID(),
      }),
    );
  }

  async function newKey(tenant: Tenant, scopes: readonly string[]): Promise<string> {
    const issued = issueToken('test');
    await first.tenant(tenant).transaction((tx) =>
      apiTokens.create(tx, {
        prefix: issued.prefix,
        secretSha256: issued.secretSha256,
        scopes,
        expiresAt: new Date('2100-01-01T00:00:00Z'),
      }),
    );
    return issued.token;
  }

  function instance(db: Database, rules: RateLimitRules) {
    const logger = memoryLogger();
    return createApp({
      routes: [readRoute, createPayout],
      authenticate: createTokenAuthenticator({
        store: databaseTokenStore(db),
        environment: 'test',
        embedOrigins: [],
        logger,
      }),
      rateLimit: createRateLimit(databaseBucketStore(db), rules),
      idempotency: memoryIdempotencyStore(),
      logger,
    });
  }

  const roomy = { capacity: 1000, refillPerSecond: 1 };

  // How many requests got through, with the time they took: a bucket refills
  // while the laptop is busy, so the bound has to allow for what time gave back.
  async function burst(
    requests: number,
    send: (index: number) => Response | Promise<Response>,
  ): Promise<{ allowed: number; refused: Response[]; seconds: number }> {
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: requests }, async (_unused, index) => send(index)),
    );
    const refused = responses.filter((response) => response.status === 429);
    const allowed = responses.filter((response) => response.status < 300).length;
    expect(allowed + refused.length).toBe(requests);
    return { allowed, refused, seconds: Math.ceil((Date.now() - started) / 1000) };
  }

  it('two API instances share one bucket', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant, ['payouts:read']);
    const rules: RateLimitRules = {
      token: { capacity: 5, refillPerSecond: 1 },
      principal: roomy,
      payoutCreation: roomy,
    };
    const one = instance(first, rules);
    const two = instance(second, rules);
    const { allowed, refused, seconds } = await burst(24, (index) =>
      (index % 2 === 0 ? one : two).request('/v1/things', {
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    // On their own the two would allow ten between them.
    expect(allowed).toBeGreaterThanOrEqual(5);
    expect(allowed).toBeLessThanOrEqual(5 + seconds);
    expect(refused.length).toBeGreaterThan(0);
    const answer = refused[0];
    expect(answer?.headers.get('retry-after')).toBe('1');
    expect(answer?.headers.get('ratelimit-limit')).toBe('5');
    expect(answer?.headers.get('ratelimit-remaining')).toBe('0');
  });

  it('limits each key on its own, and the principal across its keys', async () => {
    const tenant = await newTenant();
    const keys = [
      await newKey(tenant, ['payouts:read']),
      await newKey(tenant, ['payouts:read']),
      await newKey(tenant, ['payouts:read']),
    ];
    const rules: RateLimitRules = {
      token: { capacity: 4, refillPerSecond: 1 },
      principal: { capacity: 6, refillPerSecond: 1 },
      payoutCreation: roomy,
    };
    const app = instance(first, rules);
    const { allowed, seconds } = await burst(18, (index) =>
      app.request('/v1/things', {
        headers: { authorization: `Bearer ${keys[index % 3] ?? ''}` },
      }),
    );
    // Three keys of four would allow twelve; the principal stops it at six.
    expect(allowed).toBeGreaterThanOrEqual(6);
    expect(allowed).toBeLessThanOrEqual(6 + seconds);
  });

  it('keeps another principal out of it entirely', async () => {
    const noisy = await newTenant();
    const quiet = await newTenant();
    const noisyKey = await newKey(noisy, ['payouts:read']);
    const quietKey = await newKey(quiet, ['payouts:read']);
    const rules: RateLimitRules = {
      token: { capacity: 2, refillPerSecond: 1 },
      principal: { capacity: 2, refillPerSecond: 1 },
      payoutCreation: roomy,
    };
    const app = instance(first, rules);
    const { refused } = await burst(10, () =>
      app.request('/v1/things', { headers: { authorization: `Bearer ${noisyKey}` } }),
    );
    expect(refused.length).toBeGreaterThan(0);
    const response = await app.request('/v1/things', {
      headers: { authorization: `Bearer ${quietKey}` },
    });
    expect(response.status).toBe(200);
  });

  it('a key over its own limit does not drain the principal for the others', async () => {
    const tenant = await newTenant();
    const noisy = await newKey(tenant, ['payouts:read']);
    const quiet = await newKey(tenant, ['payouts:read']);
    const rules: RateLimitRules = {
      token: { capacity: 2, refillPerSecond: 1 },
      principal: { capacity: 6, refillPerSecond: 1 },
      payoutCreation: roomy,
    };
    const app = instance(first, rules);
    await burst(30, () =>
      app.request('/v1/things', { headers: { authorization: `Bearer ${noisy}` } }),
    );
    const response = await app.request('/v1/things', {
      headers: { authorization: `Bearer ${quiet}` },
    });
    expect(response.status).toBe(200);
  });

  it('holds payout creation to its own limit, and leaves reads alone', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant, ['payouts:read', 'payouts:write']);
    const rules: RateLimitRules = {
      token: roomy,
      principal: roomy,
      payoutCreation: { capacity: 3, refillPerSecond: 1 },
    };
    const app = instance(first, rules);
    const { allowed, seconds } = await burst(12, () =>
      app.request('/v1/payouts', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'idempotency-key': randomUUID() },
      }),
    );
    expect(allowed).toBeGreaterThanOrEqual(3);
    expect(allowed).toBeLessThanOrEqual(3 + seconds);
    const read = await app.request('/v1/things', { headers: { authorization: `Bearer ${key}` } });
    expect(read.status).toBe(200);
  });

  it('gives a refused client what it was promised after waiting', async () => {
    const tenant = await newTenant();
    const key = await newKey(tenant, ['payouts:read']);
    const rules: RateLimitRules = {
      token: { capacity: 1, refillPerSecond: 1 },
      principal: roomy,
      payoutCreation: roomy,
    };
    const app = instance(first, rules);
    const send = () => app.request('/v1/things', { headers: { authorization: `Bearer ${key}` } });
    await send();
    let refused: Response | undefined;
    for (let attempt = 0; attempt < 20 && refused === undefined; attempt += 1) {
      const response = await send();
      if (response.status === 429) refused = response;
    }
    const retryAfter = Number(refused?.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    expect((await send()).status).toBe(200);
  });
});
