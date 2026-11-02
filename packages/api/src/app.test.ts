// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomUUID } from 'node:crypto';

import { Problem, assertResponseMatchesSchema } from '@ujira/api-schema';
import { ChainUnavailableError } from '@ujira/chain-adapter';
import { DatabaseUnavailableError } from '@ujira/db';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import type { ApiDependencies } from './app.js';
import type { Authenticate, CallOptions, Tenant } from './auth.js';
import { ApiError, RouteRegistryError } from './errors.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import type { LogRecord } from './log.js';
import { allowEveryRequest } from './rate-limit.js';
import { contractRoute, definePublicRoute, defineTenantRoute } from './route.js';
import type { Route } from './route.js';

const TENANT_A: Tenant = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
};
const TENANT_B: Tenant = {
  principalId: '0199a1f6-9999-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-8888-7a55-8e21-5b9c7d3e1f04',
};
const TOKEN_ID = randomUUID();
const THING_ID = '0199a1f6-7777-7a55-8e21-5b9c7d3e1f04';
const SECRET_TOKEN = 'ujk_test_secretvaluethatmustnotbelogged';

// Keys by what they prove. The token text never reaches a log or a body.
const authenticate: Authenticate = (credentials) => {
  const token = credentials.authorization?.replace(/^Bearer /, '');
  switch (token) {
    case undefined:
      return Promise.resolve({ ok: false, code: 'TOKEN_MALFORMED' });
    case SECRET_TOKEN:
      return Promise.resolve({
        ok: true,
        tenant: { ...TENANT_A, tokenId: TOKEN_ID, scopes: ['payouts:read'] },
      });
    case 'writer':
      return Promise.resolve({
        ok: true,
        tenant: { ...TENANT_A, tokenId: TOKEN_ID, scopes: ['payouts:write'] },
      });
    case 'receipts-only':
      return Promise.resolve({
        ok: true,
        tenant: { ...TENANT_A, tokenId: TOKEN_ID, scopes: ['receipts:read'] },
      });
    case 'approver':
      return Promise.resolve({
        ok: true,
        tenant: { ...TENANT_A, tokenId: TOKEN_ID, scopes: ['approvals:write'] },
      });
    case 'bad-shape':
      return Promise.resolve({
        ok: true,
        tenant: {
          ...TENANT_A,
          tokenId: TOKEN_ID,
          principalId: TENANT_A.principalId.toUpperCase(),
          scopes: [],
        },
      });
    case 'db-down':
      return Promise.reject(new DatabaseUnavailableError('ECONNREFUSED'));
    default:
      return Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });
  }
};

const Thing = z.strictObject({
  principalId: z.string(),
  projectId: z.string(),
  id: z.uuid(),
  name: z.string(),
});

type Behaviour =
  | 'ok'
  | 'not-found'
  | 'chain-down'
  | 'db-down'
  | 'bug'
  | 'bad-shape'
  | 'leak'
  | 'hang'
  | 'hang-then-fail';

interface Seen {
  call?: CallOptions;
  tenant?: Tenant;
  requestId?: string;
}

function thingRoute(seen: Seen): Route {
  return defineTenantRoute({
    id: 'getThing',
    method: 'GET',
    path: '/v1/things/{id}',
    summary: 'One thing',
    scope: 'payouts:read',
    params: z.strictObject({ id: z.uuid() }),
    query: z.strictObject({
      behaviour: z
        .enum([
          'ok',
          'not-found',
          'chain-down',
          'db-down',
          'bug',
          'bad-shape',
          'leak',
          'hang',
          'hang-then-fail',
        ])
        .optional(),
    }),
    response: { name: 'Thing', schema: Thing },
    errors: ['NOT_FOUND'],
    handler: async ({ params, query }, context) => {
      seen.call = context.call;
      seen.tenant = context.tenant;
      seen.requestId = context.requestId;
      const behaviour: Behaviour = query.behaviour ?? 'ok';
      const thing = { ...context.tenant, id: params.id, name: 'Ada' };
      switch (behaviour) {
        case 'ok':
          context.log.info('thing_read', { resourceId: params.id });
          return thing;
        case 'not-found':
          throw new ApiError('NOT_FOUND');
        case 'chain-down':
          throw new ChainUnavailableError({ retryAfterMs: 12_000 });
        case 'db-down':
          throw new DatabaseUnavailableError('57P01');
        case 'bug':
          throw new Error('boom for alice@example.com');
        case 'bad-shape':
          return { ...thing, name: 42 } as unknown as typeof thing;
        case 'leak':
          return { ...thing, principalId: TENANT_B.principalId };
        case 'hang':
          await new Promise((resolve) => {
            context.signal.addEventListener('abort', resolve);
          });
          return thing;
        case 'hang-then-fail':
          await new Promise((resolve) => {
            context.signal.addEventListener('abort', resolve);
          });
          throw new Error('late');
      }
    },
  });
}

const createThing = defineTenantRoute({
  id: 'createThing',
  method: 'POST',
  path: '/v1/things',
  summary: 'Create a thing',
  scope: 'payouts:write',
  body: z.strictObject({ name: z.string().min(1).max(20) }),
  response: { status: 201, name: 'Thing', schema: Thing },
  handler: ({ body }, context) =>
    Promise.resolve({ ...context.tenant, id: THING_ID, name: body.name }),
});

const approvals = contractRoute('listApprovals', {
  scope: 'approvals:write',
  handler: () => Promise.resolve({ items: [], nextCursor: null }),
});

const Pong = z.strictObject({ pong: z.literal(true) });

const ping = definePublicRoute({
  id: 'ping',
  method: 'GET',
  path: '/v1/ping',
  summary: 'Ping',
  reason: 'A test route that holds no tenant data.',
  response: { name: 'Pong', schema: Pong },
  handler: (_input, context) => {
    // A public handler is given no tenant at all.
    expect(context).not.toHaveProperty('tenant');
    return Promise.resolve({ pong: true as const });
  },
});

function setup(overrides: Partial<ApiDependencies> = {}) {
  const logger = memoryLogger();
  const seen: Seen = {};
  const app = createApp({
    routes: [thingRoute(seen), createThing, approvals, ping],
    authenticate,
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    logger,
    ...overrides,
  });
  return { app, logger, seen };
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const writer = (): Record<string, string> => ({
  ...bearer('writer'),
  'idempotency-key': randomUUID(),
});

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  const body = Problem.parse(await response.json());
  expect(body.requestId).toBe(response.headers.get('request-id'));
  expect(body.status).toBe(response.status);
  return body;
}

const accessLine = (records: readonly LogRecord[]): LogRecord | undefined =>
  records.find((r) => r.event === 'request');

describe('tenant routes', () => {
  it('runs the handler as the tenant of the key, and logs it', async () => {
    const { app, logger, seen } = setup();
    const response = await app.request(`/v1/things/${THING_ID}`, { headers: bearer(SECRET_TOKEN) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...TENANT_A, id: THING_ID, name: 'Ada' });
    expect(seen.tenant).toEqual(TENANT_A);
    expect(accessLine(logger.records)).toMatchObject({
      route: '/v1/things/{id}',
      status: 200,
      ...TENANT_A,
    });
  });

  it('carries the request id into adapter calls and handler logs', async () => {
    const { app, logger, seen } = setup();
    const response = await app.request(`/v1/things/${THING_ID}`, { headers: bearer(SECRET_TOKEN) });
    const requestId = response.headers.get('request-id');
    expect(seen.call?.correlationId).toBe(requestId);
    expect(seen.requestId).toBe(requestId);
    expect(seen.call?.signal).toBeInstanceOf(AbortSignal);
    expect(logger.records.find((r) => r.event === 'thing_read')).toMatchObject({
      requestId,
      resourceId: THING_ID,
    });
  });

  it('refuses a missing key, an unknown key and a key without the scope', async () => {
    const { app } = setup();
    const missing = await app.request(`/v1/things/${THING_ID}`);
    expect(missing.status).toBe(401);
    expect((await problemOf(missing)).code).toBe('TOKEN_MALFORMED');

    const unknown = await app.request(`/v1/things/${THING_ID}`, { headers: bearer('nope') });
    expect((await problemOf(unknown)).code).toBe('TOKEN_INVALID');

    const scoped = await app.request(`/v1/things/${THING_ID}`, {
      headers: bearer('receipts-only'),
    });
    expect(scoped.status).toBe(403);
    const problem = await problemOf(scoped);
    expect(problem.code).toBe('INSUFFICIENT_SCOPE');
    expect(problem.detail).toContain('payouts:read');
  });

  it('fails closed when the authenticator returns a tenant the database would refuse', async () => {
    const { app, logger } = setup();
    const response = await app.request(`/v1/things/${THING_ID}`, { headers: bearer('bad-shape') });
    expect((await problemOf(response)).code).toBe('INTERNAL');
    expect(logger.records.map((r) => r.event)).toContain('authenticator_contract_violation');
  });

  it('answers 503 when authentication cannot reach the database', async () => {
    const { app } = setup();
    const response = await app.request(`/v1/things/${THING_ID}`, { headers: bearer('db-down') });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect((await problemOf(response)).code).toBe('DB_UNAVAILABLE');
  });

  it('blocks a response that names another tenant', async () => {
    const { app, logger } = setup();
    const response = await app.request(`/v1/things/${THING_ID}?behaviour=leak`, {
      headers: bearer(SECRET_TOKEN),
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(TENANT_B.principalId);
    expect(logger.records.find((r) => r.event === 'tenant_leak_blocked')).toMatchObject({
      issues: ['principalId'],
    });
  });

  it('serves a contract route with the contract query rules and passes the contract check', async () => {
    const { app } = setup();
    const ok = await app.request('/v1/approvals?limit=5', { headers: bearer('approver') });
    await expect(assertResponseMatchesSchema('listApprovals', ok)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const repeated = await app.request('/v1/approvals?limit=5&limit=500', {
      headers: bearer('approver'),
    });
    const problem = (await assertResponseMatchesSchema('listApprovals', repeated)) as Problem;
    expect(problem.code).toBe('LIMIT_OUT_OF_RANGE');
  });
});

describe('validation', () => {
  it('reads a malformed path id as not found', async () => {
    const { app } = setup();
    const response = await app.request('/v1/things/not-a-uuid', { headers: bearer(SECRET_TOKEN) });
    expect((await problemOf(response)).code).toBe('NOT_FOUND');
  });

  it('refuses unknown and repeated query keys with field errors', async () => {
    const { app } = setup();
    const unknown = await app.request(`/v1/things/${THING_ID}?colour=red`, {
      headers: bearer(SECRET_TOKEN),
    });
    expect(await problemOf(unknown)).toMatchObject({
      code: 'INVALID_FILTER',
      errors: [{ field: 'colour', code: 'unknown_field' }],
    });
    const repeated = await app.request(`/v1/things/${THING_ID}?behaviour=ok&behaviour=ok`, {
      headers: bearer(SECRET_TOKEN),
    });
    expect(await problemOf(repeated)).toMatchObject({
      code: 'INVALID_FILTER',
      errors: [{ field: 'behaviour', code: 'repeated_key' }],
    });
  });

  it('accepts a valid JSON body and answers with the declared status', async () => {
    const { app } = setup();
    const response = await app.request('/v1/things', {
      method: 'POST',
      headers: { ...writer(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grace' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ...TENANT_A, id: THING_ID, name: 'Grace' });
  });

  it('refuses bodies of the wrong type, size, encoding, syntax and shape', async () => {
    const { app } = setup({ bodyLimitBytes: 64 });
    const post = (body: RequestInit['body'], headers: Record<string, string> = {}) =>
      app.request('/v1/things', {
        method: 'POST',
        headers: { ...writer(), 'content-type': 'application/json', ...headers },
        body,
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);

    expect((await problemOf(await post('{}', { 'content-type': 'text/plain' }))).code).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect((await problemOf(await post(JSON.stringify({ name: 'x'.repeat(100) })))).code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
    // No Content-Length to go by: the limit still holds while reading.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1)
          controller.enqueue(new TextEncoder().encode('x'.repeat(20)));
        controller.close();
      },
    });
    expect((await problemOf(await post(stream))).code).toBe('PAYLOAD_TOO_LARGE');
    expect((await problemOf(await post(new Uint8Array([0xff, 0xfe])))).detail).toBe(
      'The body is not UTF-8',
    );
    expect((await problemOf(await post('   '))).detail).toBe('The body is empty');
    expect((await problemOf(await post(null))).detail).toBe('The body is empty');
    const syntax = await problemOf(await post('{"name": "Ada"'));
    expect(syntax).toMatchObject({ code: 'INVALID_REQUEST', detail: 'The body is not valid JSON' });
    const shape = await problemOf(await post(JSON.stringify({ name: '', extra: 1 })));
    expect(shape).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(shape.errors).toEqual(
      expect.arrayContaining([
        { field: 'name', code: 'invalid_value' },
        { field: 'extra', code: 'unknown_field' },
      ]),
    );
  });
});

describe('errors', () => {
  it('maps adapter and database outages to 503 with Retry-After', async () => {
    const { app } = setup();
    const chain = await app.request(`/v1/things/${THING_ID}?behaviour=chain-down`, {
      headers: bearer(SECRET_TOKEN),
    });
    expect(chain.status).toBe(503);
    expect(chain.headers.get('retry-after')).toBe('12');
    expect((await problemOf(chain)).code).toBe('CHAIN_UNAVAILABLE');

    const db = await app.request(`/v1/things/${THING_ID}?behaviour=db-down`, {
      headers: bearer(SECRET_TOKEN),
    });
    expect(db.headers.get('retry-after')).toBe('5');
    expect((await problemOf(db)).code).toBe('DB_UNAVAILABLE');
  });

  it('answers a thrown ApiError with its own code', async () => {
    const { app } = setup();
    const response = await app.request(`/v1/things/${THING_ID}?behaviour=not-found`, {
      headers: bearer(SECRET_TOKEN),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('turns a bug into INTERNAL, logs its class name and repeats none of its text', async () => {
    const { app, logger } = setup();
    const response = await app.request(`/v1/things/${THING_ID}?behaviour=bug`, {
      headers: bearer(SECRET_TOKEN),
    });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain('alice');
    expect(logger.records.find((r) => r.event === 'request_failed')).toMatchObject({
      level: 'error',
      errorName: 'Error',
      errorCode: 'INTERNAL',
    });
    expect(JSON.stringify(logger.records)).not.toContain('alice');
  });

  it('refuses to send a body its schema does not describe', async () => {
    const { app, logger } = setup();
    const response = await app.request(`/v1/things/${THING_ID}?behaviour=bad-shape`, {
      headers: bearer(SECRET_TOKEN),
    });
    expect((await problemOf(response)).code).toBe('INTERNAL');
    expect(logger.records.find((r) => r.event === 'response_contract_violation')).toMatchObject({
      issues: ['name'],
    });
  });

  it('answers 503 REQUEST_TIMEOUT at the deadline and logs a failure that comes later', async () => {
    const { app, logger } = setup({ requestTimeoutMs: 20 });
    const response = await app.request(`/v1/things/${THING_ID}?behaviour=hang`, {
      headers: bearer(SECRET_TOKEN),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
    expect((await problemOf(response)).code).toBe('REQUEST_TIMEOUT');

    await app.request(`/v1/things/${THING_ID}?behaviour=hang-then-fail`, {
      headers: bearer(SECRET_TOKEN),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logger.records.find((r) => r.event === 'late_failure')).toMatchObject({
      errorName: 'Error',
    });
  });

  it('answers 404 for an unknown path and 405 with Allow for a wrong method', async () => {
    const { app, logger } = setup();
    const missing = await app.request('/v1/nothing-here');
    expect((await problemOf(missing)).code).toBe('NOT_FOUND');

    const wrong = await app.request(`/v1/things/${THING_ID}`, { method: 'DELETE' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
    expect((await problemOf(wrong)).code).toBe('METHOD_NOT_ALLOWED');
    expect(logger.records.filter((r) => r.event === 'request').map((r) => r.route)).toEqual([
      'unmatched',
      'unmatched',
    ]);
  });
});

describe('logs', () => {
  it('never carry the key, the query values or the body', async () => {
    const { app, logger } = setup();
    await app.request(`/v1/things/${THING_ID}?behaviour=ok`, { headers: bearer(SECRET_TOKEN) });
    await app.request('/v1/things', {
      method: 'POST',
      headers: { ...writer(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grace' }),
    });
    const text = JSON.stringify(logger.records);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain('Grace');
    expect(text).not.toContain('behaviour');
  });
});

describe('registry', () => {
  it('refuses a route table it cannot serve as written', () => {
    const base = {
      authenticate,
      rateLimit: allowEveryRequest,
      idempotency: memoryIdempotencyStore(),
      logger: memoryLogger(),
    };
    expect(() => createApp({ ...base, routes: [ping, ping] })).toThrow(RouteRegistryError);
    const samePath = definePublicRoute({
      id: 'pingAgain',
      method: 'GET',
      path: '/v1/ping',
      summary: 'Ping',
      reason: 'A test route that holds no tenant data.',
      response: { name: 'Pong', schema: Pong },
      handler: () => Promise.resolve({ pong: true as const }),
    });
    expect(() => createApp({ ...base, routes: [ping, samePath] })).toThrow(/declared twice/);
    const outside = { ...ping, id: 'outside', path: '/v2/ping' } as Route;
    expect(() => createApp({ ...base, routes: [outside] })).toThrow(/not under \/v1\//);
    expect(() =>
      definePublicRoute({
        id: 'quiet',
        method: 'GET',
        path: '/v1/quiet',
        summary: 'Quiet',
        reason: 'no',
        response: { name: 'Quiet', schema: z.strictObject({}) },
        handler: () => Promise.resolve({}),
      }),
    ).toThrow(/must say why/);
  });

  it('replaces a request id that breaks the format', async () => {
    const { app } = setup({ newRequestId: () => 'bad id with spaces' });
    const response = await app.request('/v1/ping');
    expect(response.headers.get('request-id')).toMatch(/^req_/);
  });

  it('fails closed if a tenant route is ever handed no tenant', async () => {
    const route = thingRoute({});
    await expect(
      route.handle(
        { params: { id: THING_ID }, query: {}, body: undefined },
        {
          requestId: 'req_0123456789',
          signal: new AbortController().signal,
          call: { signal: new AbortController().signal, correlationId: 'req_0123456789' },
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
          idempotencyKey: null,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
