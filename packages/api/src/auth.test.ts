// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Token authentication through the whole pipeline, with an in-memory store that
// counts its queries. The same paths against a real database are in
// auth.db.test.ts.

import { randomUUID } from 'node:crypto';

import { Problem } from '@ujira/api-schema';
import { DatabaseUnavailableError } from '@ujira/db';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import type { Tenant } from './auth.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { allowEveryRequest } from './rate-limit.js';
import { defineTenantRoute } from './route.js';
import type { Route } from './route.js';
import { formatToken, hashSecret, issueToken } from './token.js';
import type { TokenEnvironment } from './token.js';
import { createTokenAuthenticator, TOKEN_CACHE_MAX_TTL_MS } from './token-auth.js';
import type {
  SecurityEventSink,
  TokenLookup,
  TokenSecurityEvent,
  TokenStore,
} from './token-auth.js';

const TENANT: Tenant = { principalId: randomUUID(), projectId: randomUUID() };
const OTHER: Tenant = { principalId: randomUUID(), projectId: randomUUID() };
const FUTURE = new Date('2100-01-01T00:00:00Z');
const PAST = new Date('2000-01-01T00:00:00Z');
const EMBED_ORIGIN = 'https://pay.example.test';

const Created = z.strictObject({ principalId: z.string(), projectId: z.string() });

const seen: { tenant?: Tenant } = {};

const createPayout: Route = defineTenantRoute({
  id: 'createPayout',
  method: 'POST',
  path: '/v1/payouts',
  summary: 'Request a payout',
  scope: 'payouts:write',
  rateLimit: 'payout_creation',
  body: z.looseObject({}),
  response: { status: 201, name: 'Created', schema: Created },
  handler: (_input, context) => {
    seen.tenant = context.tenant;
    return Promise.resolve({ ...context.tenant });
  },
});

function memoryStore() {
  const rows = new Map<string, TokenLookup>();
  const counts = { finds: 0, touches: 0 };
  let failTouch = false;
  let failFind = false;
  const store: TokenStore = {
    find: (prefix) => {
      counts.finds += 1;
      if (failFind) return Promise.reject(new DatabaseUnavailableError('ECONNREFUSED'));
      return Promise.resolve(rows.get(prefix));
    },
    touchLastUsed: () => {
      counts.touches += 1;
      return failTouch ? Promise.reject(new Error('boom')) : Promise.resolve();
    },
  };
  return {
    store,
    rows,
    counts,
    failTouches: () => {
      failTouch = true;
    },
    failFinds: () => {
      failFind = true;
    },
  };
}

type Memory = ReturnType<typeof memoryStore>;

function put(memory: Memory, overrides: Partial<TokenLookup> = {}, env: TokenEnvironment = 'test') {
  const issued = issueToken(env);
  memory.rows.set(issued.prefix, {
    tokenId: randomUUID(),
    ...TENANT,
    secretSha256: issued.secretSha256,
    scopes: ['payouts:write'],
    expiresAt: FUTURE,
    revokedAt: null,
    ...overrides,
  });
  return issued;
}

function served(
  memory: Memory,
  options: {
    environment?: TokenEnvironment;
    now?: () => Date;
    cacheTtlMs?: number;
    cacheMaxEntries?: number;
    securityEvents?: SecurityEventSink;
  } = {},
) {
  const logger = memoryLogger();
  const events: TokenSecurityEvent[] = [];
  const recorded: SecurityEventSink = (event) => {
    events.push(event);
    return Promise.resolve();
  };
  const app = createApp({
    routes: [createPayout],
    authenticate: createTokenAuthenticator({
      store: memory.store,
      securityEvents: options.securityEvents ?? recorded,
      environment: options.environment ?? 'test',
      embedOrigins: [EMBED_ORIGIN],
      logger,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
      ...(options.cacheMaxEntries === undefined
        ? {}
        : { cacheMaxEntries: options.cacheMaxEntries }),
    }),
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    logger,
  });
  const post = (headers: Record<string, string>, body: unknown = {}, path = '/v1/payouts') =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...headers },
      body: JSON.stringify(body),
    });
  const withKey = (token: string, headers: Record<string, string> = {}, body: unknown = {}) =>
    post({ authorization: `Bearer ${token}`, ...headers }, body);
  return { app, logger, events, post, withKey };
}

async function codeOf(response: Response): Promise<string> {
  const problem = Problem.parse(await response.json());
  expect(problem.status).toBe(response.status);
  return problem.code;
}

describe('who gets in', () => {
  it('lets a good key in as its tenant', async () => {
    const memory = memoryStore();
    const response = await served(memory).withKey(put(memory).token);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(TENANT);
  });

  it('unknown, wrong secret, expired and revoked tokens get 401', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const good = put(memory);
    const unknown = issueToken('test').token;
    // A well formed key whose prefix exists and whose secret is someone else's.
    const stranger = issueToken('test');
    memory.rows.set(stranger.prefix, {
      tokenId: randomUUID(),
      ...TENANT,
      secretSha256: hashSecret('some other secret'),
      scopes: ['payouts:write'],
      expiresAt: FUTURE,
      revokedAt: null,
    });
    const expired = put(memory, { expiresAt: PAST });
    const revoked = put(memory, { revokedAt: PAST });
    for (const token of [unknown, stranger.token, expired.token, revoked.token]) {
      const response = await api.withKey(token);
      expect(response.status).toBe(401);
      // All four read the same, so none says which prefixes exist.
      expect(await codeOf(response)).toBe('TOKEN_INVALID');
    }
    expect((await api.withKey(good.token)).status).toBe(201);
  });

  it('refuses a stored hash of the wrong length as a mismatch', async () => {
    const memory = memoryStore();
    const issued = put(memory, { secretSha256: Buffer.alloc(16, 1) });
    expect(await codeOf(await served(memory).withKey(issued.token))).toBe('TOKEN_INVALID');
  });

  it('token without payouts:write gets 403 on POST /v1/payouts', async () => {
    const memory = memoryStore();
    const issued = put(memory, { scopes: ['payouts:read'] });
    const response = await served(memory).withKey(issued.token);
    expect(response.status).toBe(403);
    const problem = Problem.parse(await response.json());
    expect(problem.code).toBe('INSUFFICIENT_SCOPE');
    expect(problem.detail).toContain('payouts:write');
  });

  it('a principal id in the body is ignored', async () => {
    const memory = memoryStore();
    const issued = put(memory);
    const response = await served(memory).withKey(
      issued.token,
      {},
      {
        principalId: OTHER.principalId,
        projectId: OTHER.projectId,
      },
    );
    expect(response.status).toBe(201);
    expect(seen.tenant).toEqual(TENANT);
    expect(await response.json()).toEqual(TENANT);
  });

  it('fails closed on a stored scope this code does not know', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const issued = put(memory, { scopes: ['payouts:admin'] });
    const response = await api.withKey(issued.token);
    expect(response.status).toBe(500);
    expect(api.logger.records.find((r) => r.event === 'request_failed')).toMatchObject({
      errorName: 'TokenRecordError',
    });
  });

  it('answers 503 when the lookup cannot reach the database', async () => {
    const memory = memoryStore();
    memory.failFinds();
    const response = await served(memory).withKey(issueToken('test').token);
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe('DB_UNAVAILABLE');
  });
});

describe('what never reaches the database', () => {
  it('a bad checksum is rejected with zero queries', async () => {
    const memory = memoryStore();
    const { token } = put(memory);
    const last = token.at(-1) === 'a' ? 'b' : 'a';
    const response = await served(memory).withKey(`${token.slice(0, -1)}${last}`);
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('TOKEN_MALFORMED');
    expect(memory.counts).toEqual({ finds: 0, touches: 0 });
  });

  it.each([
    ['no header', {}],
    ['another scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['no token', { authorization: 'Bearer ' }],
    ['two tokens', { authorization: 'Bearer one two' }],
    ['a string that is not a key', { authorization: 'Bearer not-a-key' }],
  ])('%s is malformed, with zero queries', async (_name, headers) => {
    const memory = memoryStore();
    const response = await served(memory).post(headers);
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('TOKEN_MALFORMED');
    expect(memory.counts.finds).toBe(0);
  });

  it('a key in the query string is never read', async () => {
    const memory = memoryStore();
    const { token } = put(memory);
    const response = await served(memory).post({}, {}, `/v1/payouts?access_token=${token}`);
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('TOKEN_MALFORMED');
    expect(memory.counts.finds).toBe(0);
  });

  it('a test key in production gives TOKEN_ENVIRONMENT_MISMATCH', async () => {
    const memory = memoryStore();
    const { token } = put(memory);
    const response = await served(memory, { environment: 'live' }).withKey(token);
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('TOKEN_ENVIRONMENT_MISMATCH');
    expect(memory.counts.finds).toBe(0);
  });

  it('a live key in the sandbox gives TOKEN_ENVIRONMENT_MISMATCH', async () => {
    const memory = memoryStore();
    const { token } = put(memory, {}, 'live');
    const response = await served(memory, { environment: 'test' }).withKey(token);
    expect(await codeOf(response)).toBe('TOKEN_ENVIRONMENT_MISMATCH');
    expect(memory.counts.finds).toBe(0);
  });
});

describe('security events', () => {
  it('records a key that fails the lookup, by its prefix only', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const unknown = issueToken('test');
    await api.withKey(unknown.token);
    expect(api.events).toEqual([{ kind: 'token_invalid', tokenPrefix: unknown.prefix }]);
    expect(JSON.stringify(api.events)).not.toContain(unknown.token);
  });

  it('records a wrong secret, an expired key and a revoked key alike', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const good = put(memory);
    const expired = put(memory, { expiresAt: PAST });
    const revoked = put(memory, { revokedAt: PAST });
    await api.withKey(formatToken(good.prefix, 'a'.repeat(52)));
    await api.withKey(expired.token);
    await api.withKey(revoked.token);
    expect(api.events).toEqual([
      { kind: 'token_invalid', tokenPrefix: good.prefix },
      { kind: 'token_invalid', tokenPrefix: expired.prefix },
      { kind: 'token_invalid', tokenPrefix: revoked.prefix },
    ]);
  });

  it('records a key from the wrong environment', async () => {
    const memory = memoryStore();
    const issued = put(memory);
    const api = served(memory, { environment: 'live' });
    await api.withKey(issued.token);
    expect(api.events).toEqual([{ kind: 'token_env_mismatch', tokenPrefix: issued.prefix }]);
  });

  it('records nothing for a good key, or for a string that is not a key', async () => {
    const memory = memoryStore();
    const api = served(memory);
    await api.withKey(put(memory).token);
    await api.withKey('not-a-key');
    await api.post({});
    expect(api.events).toEqual([]);
  });

  it('still refuses when the record cannot be written, and logs that it was lost', async () => {
    const memory = memoryStore();
    const api = served(memory, { securityEvents: () => Promise.reject(new Error('down')) });
    const response = await api.withKey(issueToken('test').token);
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('TOKEN_INVALID');
    expect(api.logger.records.find((r) => r.event === 'security_event_failed')).toMatchObject({
      level: 'warn',
      errorName: 'Error',
    });
  });
});

describe('browsers', () => {
  it('refuses a key sent from an origin that is not an allowed embed', async () => {
    const memory = memoryStore();
    const { token } = put(memory);
    const response = await served(memory).withKey(token, { origin: 'https://evil.example.test' });
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('ORIGIN_NOT_ALLOWED');
    expect(memory.counts.finds).toBe(0);
  });

  it('treats the opaque null origin as not allowed', async () => {
    const memory = memoryStore();
    const { token } = put(memory);
    expect(await codeOf(await served(memory).withKey(token, { origin: 'null' }))).toBe(
      'ORIGIN_NOT_ALLOWED',
    );
  });

  it('allows an embed origin, and a server with no Origin at all', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const { token } = put(memory);
    expect((await api.withKey(token, { origin: EMBED_ORIGIN })).status).toBe(201);
    expect((await api.withKey(token)).status).toBe(201);
  });

  it('sends no CORS header, even to an allowed origin', async () => {
    const memory = memoryStore();
    const { token } = put(memory);
    const api = served(memory);
    const allowed = await api.withKey(token, { origin: EMBED_ORIGIN });
    const refused = await api.withKey(token, { origin: 'https://evil.example.test' });
    const preflight = await api.app.request('/v1/payouts', {
      method: 'OPTIONS',
      headers: { origin: EMBED_ORIGIN, 'access-control-request-method': 'POST' },
    });
    for (const response of [allowed, refused, preflight]) {
      const cors = [...response.headers.keys()].filter((name) =>
        name.startsWith('access-control-'),
      );
      expect(cors).toEqual([]);
    }
  });
});

describe('the positive cache', () => {
  function clock(start = 1_000_000) {
    let at = start;
    return {
      now: () => new Date(at),
      advance: (ms: number) => {
        at += ms;
      },
    };
  }

  it('looks a key up once within its window, and again after it', async () => {
    const memory = memoryStore();
    const time = clock();
    const api = served(memory, { now: time.now });
    const { token } = put(memory);
    await api.withKey(token);
    await api.withKey(token);
    expect(memory.counts.finds).toBe(1);
    time.advance(TOKEN_CACHE_MAX_TTL_MS - 1);
    await api.withKey(token);
    expect(memory.counts.finds).toBe(1);
    time.advance(1);
    await api.withKey(token);
    expect(memory.counts.finds).toBe(2);
  });

  it('never holds a key longer than 30 seconds, whatever it is told', async () => {
    const memory = memoryStore();
    const time = clock();
    const api = served(memory, { now: time.now, cacheTtlMs: 3_600_000 });
    const { token } = put(memory);
    await api.withKey(token);
    time.advance(TOKEN_CACHE_MAX_TTL_MS);
    await api.withKey(token);
    expect(memory.counts.finds).toBe(2);
  });

  it('still compares the secret on a hit', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const good = put(memory);
    await api.withKey(good.token);
    // The right prefix with a checksum that holds and a secret that does not.
    const response = await api.withKey(formatToken(good.prefix, 'a'.repeat(52)));
    expect(await codeOf(response)).toBe('TOKEN_INVALID');
    expect(memory.counts.finds).toBe(1);
  });

  it('stops a revoked key when the window ends', async () => {
    const memory = memoryStore();
    const time = clock();
    const api = served(memory, { now: time.now });
    const issued = put(memory);
    expect((await api.withKey(issued.token)).status).toBe(201);
    const row = memory.rows.get(issued.prefix);
    if (row === undefined) throw new Error('no row');
    memory.rows.set(issued.prefix, { ...row, revokedAt: time.now() });
    expect((await api.withKey(issued.token)).status).toBe(201);
    time.advance(TOKEN_CACHE_MAX_TTL_MS);
    expect(await codeOf(await api.withKey(issued.token))).toBe('TOKEN_INVALID');
  });

  it('stops a key at its expiry even while it is cached', async () => {
    const memory = memoryStore();
    const time = clock();
    const api = served(memory, { now: time.now });
    const issued = put(memory, { expiresAt: new Date(time.now().getTime() + 1_000) });
    expect((await api.withKey(issued.token)).status).toBe(201);
    time.advance(1_000);
    expect(await codeOf(await api.withKey(issued.token))).toBe('TOKEN_INVALID');
    expect(memory.counts.finds).toBe(1);
  });

  it('caches no failure, so a key created a moment later works', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const issued = issueToken('test');
    expect(await codeOf(await api.withKey(issued.token))).toBe('TOKEN_INVALID');
    memory.rows.set(issued.prefix, {
      tokenId: randomUUID(),
      ...TENANT,
      secretSha256: issued.secretSha256,
      scopes: ['payouts:write'],
      expiresAt: FUTURE,
      revokedAt: null,
    });
    expect((await api.withKey(issued.token)).status).toBe(201);
  });

  it('holds a bounded number of keys, dropping the oldest', async () => {
    const memory = memoryStore();
    const api = served(memory, { cacheMaxEntries: 1 });
    const first = put(memory);
    const second = put(memory);
    await api.withKey(first.token);
    await api.withKey(second.token);
    await api.withKey(second.token);
    expect(memory.counts.finds).toBe(2);
    await api.withKey(first.token);
    expect(memory.counts.finds).toBe(3);
  });
});

describe('last used', () => {
  it('is recorded on a lookup, not on a cache hit, and not for a refused key', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const good = put(memory);
    await api.withKey(good.token);
    await api.withKey(good.token);
    expect(memory.counts.touches).toBe(1);
    await api.withKey(put(memory, { revokedAt: PAST }).token);
    expect(memory.counts.touches).toBe(1);
  });

  it('a failure to record it is logged and does not refuse the key', async () => {
    const memory = memoryStore();
    memory.failTouches();
    const api = served(memory);
    const response = await api.withKey(put(memory).token);
    expect(response.status).toBe(201);
    expect(api.logger.records.find((r) => r.event === 'token_touch_failed')).toMatchObject({
      level: 'warn',
      errorName: 'Error',
      ...TENANT,
    });
  });
});

describe('logs', () => {
  it('never carry a key, its prefix or its hash, on any path', async () => {
    const memory = memoryStore();
    const api = served(memory);
    const good = put(memory);
    const revoked = put(memory, { revokedAt: PAST });
    const typo = `${good.token.slice(0, -1)}${good.token.at(-1) === 'a' ? 'b' : 'a'}`;
    await api.withKey(good.token);
    await api.withKey(revoked.token);
    await api.withKey(typo);
    const text = JSON.stringify(api.logger.records);
    expect(api.logger.records.length).toBeGreaterThan(0);
    for (const issued of [good, revoked]) {
      expect(text).not.toContain(issued.token);
      expect(text).not.toContain(issued.prefix);
      expect(text).not.toContain(issued.secretSha256.toString('hex'));
    }
    expect(text).not.toContain(typo);
  });

  it('name the tenant once the key is known, so a refusal can be traced', async () => {
    const memory = memoryStore();
    const api = served(memory);
    await api.withKey(put(memory, { scopes: ['payouts:read'] }).token);
    expect(api.logger.records.find((r) => r.event === 'request')).toMatchObject({
      status: 403,
      errorCode: 'INSUFFICIENT_SCOPE',
      ...TENANT,
    });
  });
});
