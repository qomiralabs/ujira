// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Idempotency through the whole pipeline, with an in-memory store for the rules
// and a real database for the guarantee: what stops a duplicate across instances
// is a unique constraint, so that has to be shown against one.

import { randomUUID } from 'node:crypto';

import { Problem } from '@ujira/api-schema';
import { entryPoints } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import type { ApiDependencies } from './app.js';
import type { Authenticate, Tenant } from './auth.js';
import { ApiError } from './errors.js';
import {
  IDEMPOTENCY_LEASE_SECONDS,
  isFinalStatus,
  memoryIdempotencyStore,
  requestFingerprint,
} from './idempotency.js';
import type { IdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { databaseIdempotencyStore } from './postgres-stores.js';
import { allowEveryRequest } from './rate-limit.js';
import { defineTenantRoute } from './route.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const TENANT: Tenant = { principalId: randomUUID(), projectId: randomUUID() };
const OTHER: Tenant = { principalId: randomUUID(), projectId: randomUUID() };

const Thing = z.strictObject({ id: z.string(), runs: z.number() });

type Behaviour = 'ok' | 'refuse' | 'outage' | 'bug' | 'hang';

interface Handler {
  runs: number;
  keys: (string | null)[];
  release: () => void;
}

function handlerState(): Handler {
  return { runs: 0, keys: [], release: () => undefined };
}

function thingRoutes(state: Handler) {
  return [
    defineTenantRoute({
      id: 'createThing',
      method: 'POST',
      path: '/v1/things',
      summary: 'Create a thing',
      scope: 'payouts:write',
      body: z.strictObject({
        name: z.string(),
        behaviour: z.enum(['ok', 'refuse', 'outage', 'bug', 'hang']).optional(),
      }),
      response: { status: 201, name: 'Thing', schema: Thing },
      errors: ['MANDATE_REFUSED'],
      handler: async ({ body }, context) => {
        state.runs += 1;
        state.keys.push(context.idempotencyKey);
        const behaviour: Behaviour = body.behaviour ?? 'ok';
        switch (behaviour) {
          case 'ok':
            return { id: body.name, runs: state.runs };
          case 'refuse':
            throw new ApiError('MANDATE_REFUSED');
          case 'outage':
            throw new ApiError('CHAIN_UNAVAILABLE');
          case 'bug':
            throw new Error('boom');
          case 'hang':
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
            return { id: body.name, runs: state.runs };
        }
      },
    }),
    defineTenantRoute({
      id: 'deleteThing',
      method: 'DELETE',
      path: '/v1/things/{id}',
      summary: 'Delete a thing',
      scope: 'payouts:write',
      params: z.strictObject({ id: z.string() }),
      response: { name: 'Thing', schema: Thing },
      handler: ({ params }) => {
        state.runs += 1;
        return Promise.resolve({ id: params.id, runs: state.runs });
      },
    }),
    defineTenantRoute({
      id: 'getThing',
      method: 'GET',
      path: '/v1/things/{id}',
      summary: 'Read a thing',
      scope: 'payouts:write',
      params: z.strictObject({ id: z.string() }),
      response: { name: 'Thing', schema: Thing },
      handler: ({ params }) => {
        state.keys.push(null);
        return Promise.resolve({ id: params.id, runs: 0 });
      },
    }),
  ];
}

const asTenant =
  (tenant: Tenant): Authenticate =>
  () =>
    Promise.resolve({
      ok: true,
      tenant: { ...tenant, tokenId: randomUUID(), scopes: ['payouts:write'] },
    });

function served(overrides: Partial<ApiDependencies> = {}) {
  const logger = memoryLogger();
  const state = handlerState();
  const app = createApp({
    routes: thingRoutes(state),
    authenticate: asTenant(TENANT),
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    logger,
    ...overrides,
  });
  const post = (key: string | null, body: unknown = { name: 'Ada' }, path = '/v1/things') =>
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    });
  return { app, logger, state, post };
}

async function codeOf(response: Response): Promise<string> {
  return Problem.parse(await response.json()).code;
}

describe('a retry', () => {
  it('same key same body returns the stored response', async () => {
    const { post, state } = served();
    const key = randomUUID();
    const first = await post(key);
    const second = await post(key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const original = await first.text();
    expect(await second.text()).toBe(original);
    expect(state.runs).toBe(1);
  });

  it('is marked as a replay, under the request id it first answered with', async () => {
    const { post } = served();
    const key = randomUUID();
    const first = await post(key);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    const second = await post(key);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.headers.get('request-id')).toBe(first.headers.get('request-id'));
    expect(second.headers.get('content-type')).toBe(first.headers.get('content-type'));
  });

  it('logs the replay, naming the request it repeats', async () => {
    const { post, logger } = served();
    const key = randomUUID();
    const first = await post(key);
    await post(key);
    expect(logger.records.find((r) => r.event === 'idempotent_replay')).toMatchObject({
      resourceId: first.headers.get('request-id'),
    });
    expect(JSON.stringify(logger.records)).not.toContain(key);
  });

  it('of a refusal gets the same refusal, without running again', async () => {
    const { post, state } = served();
    const key = randomUUID();
    const first = await post(key, { name: 'Ada', behaviour: 'refuse' });
    const second = await post(key, { name: 'Ada', behaviour: 'refuse' });
    expect(first.status).toBe(422);
    const original = await first.text();
    const repeated = await second.text();
    expect(repeated).toBe(original);
    expect(Problem.parse(JSON.parse(repeated)).requestId).toBe(second.headers.get('request-id'));
    expect(state.runs).toBe(1);
  });

  it.each([
    ['an outage', 'outage', 503],
    ['a bug', 'bug', 500],
  ] as const)(
    'after %s runs again, since that answer says to try again',
    async (_n, behaviour, status) => {
      const { post, state } = served();
      const key = randomUUID();
      const first = await post(key, { name: 'Ada', behaviour });
      expect(first.status).toBe(status);
      const second = await post(key, { name: 'Ada', behaviour });
      expect(second.status).toBe(status);
      expect(second.headers.get('idempotent-replayed')).toBeNull();
      expect(state.runs).toBe(2);
    },
  );

  it('hands the key to the handler, for a unique constraint of its own', async () => {
    const { post, state } = served();
    const key = randomUUID();
    await post(key);
    expect(state.keys).toEqual([key]);
  });
});

describe('a reused key', () => {
  it('same key different body returns 422', async () => {
    const { post, state } = served();
    const key = randomUUID();
    await post(key, { name: 'Ada' });
    const response = await post(key, { name: 'Grace' });
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(state.runs).toBe(1);
  });

  it('on another route returns 422 too', async () => {
    const { app, post } = served();
    const key = randomUUID();
    await post(key);
    const response = await app.request('/v1/things/x', {
      method: 'DELETE',
      headers: { 'idempotency-key': key },
    });
    expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('with a different query returns 422', async () => {
    const { app } = served();
    const key = randomUUID();
    const remove = (path: string) =>
      app.request(path, { method: 'DELETE', headers: { 'idempotency-key': key } });
    expect((await remove('/v1/things/x')).status).toBe(200);
    expect(await codeOf(await remove('/v1/things/y'))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('is not a reuse in another tenant', async () => {
    const store = memoryIdempotencyStore();
    const key = randomUUID();
    const mine = served({ idempotency: store });
    const theirs = served({ idempotency: store, authenticate: asTenant(OTHER) });
    expect((await mine.post(key, { name: 'Ada' })).status).toBe(201);
    expect((await theirs.post(key, { name: 'Grace' })).status).toBe(201);
    expect(theirs.state.runs).toBe(1);
  });
});

describe('the header', () => {
  it('POST without Idempotency-Key returns 400', async () => {
    const { post, state } = served();
    const response = await post(null);
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(state.runs).toBe(0);
  });

  it('DELETE without Idempotency-Key returns 400', async () => {
    const { app } = served();
    const response = await app.request('/v1/things/x', { method: 'DELETE' });
    expect(await codeOf(response)).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it.each([
    ['too long', 'a'.repeat(256)],
    ['spaces', 'has space'],
    ['an email', 'someone@example.com'],
  ])('refuses a key with %s, without echoing it', async (_name, key) => {
    const { post, logger } = served();
    const response = await post(key);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(key);
    expect(JSON.stringify(logger.records)).not.toContain(key);
  });

  it('is not needed on a read', async () => {
    const { app } = served();
    expect((await app.request('/v1/things/x')).status).toBe(200);
  });

  it('is asked for only after the key and its scope are known', async () => {
    const { post } = served({
      authenticate: () => Promise.resolve({ ok: false, code: 'TOKEN_MALFORMED' }),
    });
    expect((await post(null)).status).toBe(401);
  });
});

describe('what uses up a key', () => {
  it('an invalid body does not, since it never ran', async () => {
    const { post, state } = served();
    const key = randomUUID();
    expect((await post(key, { name: 1 })).status).toBe(400);
    expect((await post(key, { name: 'Ada' })).status).toBe(201);
    expect(state.runs).toBe(1);
  });
});

describe('a concurrent duplicate', () => {
  it('gets 409 with Retry-After while the first runs, then the stored answer', async () => {
    const { post, state } = served();
    const key = randomUUID();
    const body = { name: 'Ada', behaviour: 'hang' };
    const first = post(key, body);
    await vitestWaitFor(() => state.runs === 1);
    const second = await post(key, body);
    expect(second.status).toBe(409);
    expect(second.headers.get('retry-after')).toBe('1');
    expect(await codeOf(second)).toBe('IDEMPOTENCY_IN_PROGRESS');
    state.release();
    const original = await first;
    expect(original.status).toBe(201);
    const third = await post(key, body);
    expect(await third.text()).toBe(await original.text());
    expect(state.runs).toBe(1);
  });

  it('still cannot start past the deadline, and gets the answer once it finishes', async () => {
    // The client got its 503 but the handler is still running, so a retry
    // starting now would run it twice.
    const { post, state } = served({ requestTimeoutMs: 20 });
    const key = randomUUID();
    const body = { name: 'Ada', behaviour: 'hang' };
    const timedOut = await post(key, body);
    expect(await codeOf(timedOut)).toBe('REQUEST_TIMEOUT');
    expect(await codeOf(await post(key, body))).toBe('IDEMPOTENCY_IN_PROGRESS');
    state.release();
    await vitestWaitFor(async () => (await post(key, body)).status === 201);
    expect(state.runs).toBe(1);
  });
});

describe('when the store fails', () => {
  const failing = (overrides: Partial<IdempotencyStore>): IdempotencyStore => ({
    ...memoryIdempotencyStore(),
    ...overrides,
  });

  it('does not run the handler if the key cannot be reserved', async () => {
    const { post, state } = served({
      idempotency: failing({ reserve: () => Promise.reject(new Error('down')) }),
    });
    expect((await post(randomUUID())).status).toBe(500);
    expect(state.runs).toBe(0);
  });

  it('still answers truly when the answer cannot be stored, and logs it', async () => {
    const { post, logger } = served({
      idempotency: failing({ complete: () => Promise.reject(new Error('down')) }),
    });
    expect((await post(randomUUID())).status).toBe(201);
    expect(logger.records.find((r) => r.event === 'idempotency_complete_failed')).toMatchObject({
      level: 'error',
      errorName: 'Error',
    });
  });

  it('logs when an attempt finds its lease has gone', async () => {
    const { post, logger } = served({
      idempotency: failing({ complete: () => Promise.resolve(false) }),
    });
    expect((await post(randomUUID())).status).toBe(201);
    expect(logger.records.find((r) => r.event === 'idempotency_lease_lost')).toBeDefined();
  });

  it('answers with the original failure when the key cannot be given back', async () => {
    const { post, logger } = served({
      idempotency: failing({ release: () => Promise.reject(new Error('down')) }),
    });
    const response = await post(randomUUID(), { name: 'Ada', behaviour: 'outage' });
    expect(await codeOf(response)).toBe('CHAIN_UNAVAILABLE');
    expect(logger.records.find((r) => r.event === 'idempotency_release_failed')).toBeDefined();
  });
});

describe('the helpers', () => {
  const url = (path: string) => new URL(`http://x${path}`);
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('gives the same request the same fingerprint, and each difference a new one', () => {
    const base = requestFingerprint('POST', url('/v1/a?b=1'), bytes('{}'));
    expect(requestFingerprint('POST', url('/v1/a?b=1'), bytes('{}'))).toEqual(base);
    for (const other of [
      requestFingerprint('PUT', url('/v1/a?b=1'), bytes('{}')),
      requestFingerprint('POST', url('/v1/b?b=1'), bytes('{}')),
      requestFingerprint('POST', url('/v1/a?b=2'), bytes('{}')),
      requestFingerprint('POST', url('/v1/a?b=1'), bytes('{ }')),
      requestFingerprint('POST', url('/v1/a?b=1'), null),
    ]) {
      expect(other).not.toEqual(base);
    }
  });

  it('keeps parts from running into each other', () => {
    expect(requestFingerprint('POST', url('/v1/a?x'), null)).not.toEqual(
      requestFingerprint('POST', url('/v1/a'), bytes('?x')),
    );
  });

  it.each([
    [200, true],
    [201, true],
    [404, true],
    [422, true],
    [429, false],
    [500, false],
    [503, false],
  ])('treats a %i as final: %s', (status, final) => {
    expect(isFinalStatus(status)).toBe(final);
  });

  it('holds the key longer than any request can run', () => {
    expect(IDEMPOTENCY_LEASE_SECONDS).toBeGreaterThan(60);
  });
});

describe('the memory store', () => {
  const CALL = { signal: new AbortController().signal, correlationId: 'req_test' };
  const HASH = Buffer.alloc(32, 1);
  const reserve = { key: 'k', requestSha256: HASH, leaseSeconds: 10 };

  it('lets the same request take over once a lease runs out, as the real one does', async () => {
    let at = 0;
    const store = memoryIdempotencyStore(() => new Date(at));
    expect((await store.reserve(TENANT, reserve, CALL)).kind).toBe('started');
    at = 9_000;
    expect((await store.reserve(TENANT, reserve, CALL)).kind).toBe('in_progress');
    at = 10_000;
    expect((await store.reserve(TENANT, reserve, CALL)).kind).toBe('started');
  });

  it('fences an attempt that lost its lease', async () => {
    const store = memoryIdempotencyStore();
    const finish = { key: 'k', leaseId: 'nope', status: 201, requestId: 'r', body: '{}' };
    await store.reserve(TENANT, reserve, CALL);
    expect(await store.complete(TENANT, finish, CALL)).toBe(false);
    expect(await store.release(TENANT, { key: 'k', leaseId: 'nope' }, CALL)).toBe(false);
  });
});

describe('against the database', () => {
  const adminUrl = inject('dbAdminUrl');
  const roleUrls = inject('dbRoleUrls');

  let database: TestDatabase;
  let first: Database;
  let second: Database;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl, import.meta.url);
    first = databaseAsServiceRoles(roleUrls, database, 4);
    second = databaseAsServiceRoles(roleUrls, database, 4);
  });

  afterAll(async () => {
    await first.close();
    await second.close();
    await database.drop();
  });

  async function newTenant(): Promise<Tenant> {
    return first.unscoped((tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'Tenant',
        projectName: 'Main',
        ownerUserId: randomUUID(),
      }),
    );
  }

  it('same key same body returns the stored response', async () => {
    const tenant = await newTenant();
    const { post, state } = served({
      authenticate: asTenant(tenant),
      idempotency: databaseIdempotencyStore(first),
    });
    const key = randomUUID();
    const original = await post(key);
    const repeated = await post(key);
    expect(original.status).toBe(201);
    expect(await repeated.text()).toBe(await original.text());
    expect(state.runs).toBe(1);
  });

  it('same key different body returns 422', async () => {
    const tenant = await newTenant();
    const { post } = served({
      authenticate: asTenant(tenant),
      idempotency: databaseIdempotencyStore(first),
    });
    const key = randomUUID();
    await post(key, { name: 'Ada' });
    expect(await codeOf(await post(key, { name: 'Grace' }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('two instances racing on one key run the handler once', async () => {
    const tenant = await newTenant();
    const state = handlerState();
    const instance = (db: Database) =>
      createApp({
        routes: thingRoutes(state),
        authenticate: asTenant(tenant),
        rateLimit: allowEveryRequest,
        idempotency: databaseIdempotencyStore(db),
        logger: memoryLogger(),
      });
    const one = instance(first);
    const two = instance(second);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) =>
        (index % 2 === 0 ? one : two).request('/v1/things', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ name: 'Ada' }),
        }),
      ),
    );
    expect(state.runs).toBe(1);
    // One ran, and each other either found it running or found it finished.
    for (const response of responses) expect([201, 409]).toContain(response.status);
    expect(
      responses.filter((r) => r.headers.get('idempotent-replayed') === null && r.status === 201),
    ).toHaveLength(1);
  });

  it('keeps tenants apart: one key, two tenants, two runs and two answers', async () => {
    const alpha = await newTenant();
    const bravo = await newTenant();
    const store = databaseIdempotencyStore(first);
    const key = randomUUID();
    const mine = served({ authenticate: asTenant(alpha), idempotency: store });
    const theirs = served({ authenticate: asTenant(bravo), idempotency: store });
    const a = await mine.post(key, { name: 'alpha only' });
    const b = await theirs.post(key, { name: 'bravo only' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await b.text()).not.toContain('alpha only');
    expect(b.headers.get('idempotent-replayed')).toBeNull();
  });

  it('runs again after a failure worth retrying', async () => {
    const tenant = await newTenant();
    const { post, state } = served({
      authenticate: asTenant(tenant),
      idempotency: databaseIdempotencyStore(first),
    });
    const key = randomUUID();
    const body = { name: 'Ada', behaviour: 'outage' };
    expect((await post(key, body)).status).toBe(503);
    expect((await post(key, body)).status).toBe(503);
    expect(state.runs).toBe(2);
  });
});

async function vitestWaitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition never held');
}
