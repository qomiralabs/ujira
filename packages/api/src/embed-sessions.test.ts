// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the embed routes through the whole pipeline, over a store in memory.
 * embed-invite.test.ts runs the same rules against the real table.
 *
 * A token is minted with an API key holding recipients:write, lasts 30 minutes and is
 * stored only as a hash. It is accepted only on /v1/embed/* routes, only from an
 * allowed origin, only for its own recipient.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import type { ApiScope, Authenticate } from './auth.js';
import { createEmbedAuthenticator } from './embed-auth.js';
import type { EmbedTokenLookup } from './embed-auth.js';
import { issueEmbedCredential } from './embed-token.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { allowEveryRequest, allowEveryAddress } from './rate-limit.js';
import { defineTenantRoute } from './route.js';
import { EMBED_TOKEN_SECONDS, embedRoutes } from './routes/embed.js';
import type { EmbedStore, NewEmbedRow } from './routes/embed.js';
import { createTokenAuthenticator } from './token-auth.js';

const NOW = new Date('2027-03-01T10:00:00.000Z');
const ORIGIN = 'https://widget.example.test';
const ELSEWHERE = 'https://evil.example.test';
const KEY = 'test-api-key';
const TENANT = { principalId: randomUUID(), projectId: randomUUID() };
const RECIPIENT = randomUUID();
const OTHER_RECIPIENT = randomUUID();

const hex = (hash: Buffer) => hash.toString('hex');

function memoryStore() {
  const rows = new Map<string, EmbedTokenLookup>();
  const created: NewEmbedRow[] = [];
  const store: EmbedStore = {
    find: (hash) => Promise.resolve(rows.get(hex(hash))),
    recipientExists: (_tenant, id) => Promise.resolve(id === RECIPIENT || id === OTHER_RECIPIENT),
    create: (tenant, row) => {
      created.push(row);
      if (row.kind === 'token') {
        rows.set(hex(row.secretSha256), {
          sessionId: randomUUID(),
          ...tenant,
          recipientId: row.recipientId,
          purpose: row.purpose,
          allowedOrigins: row.allowedOrigins,
          expiresAt: row.expiresAt,
          consumedAt: null,
        });
      }
      return Promise.resolve();
    },
    exchange: () => Promise.resolve(undefined),
  };
  return { store, rows, created };
}

const Payouts = z.strictObject({ ok: z.boolean() });

function served(scopes: readonly ApiScope[] = ['recipients:write']) {
  const memory = memoryStore();
  const clock = { now: NOW };
  const now = () => clock.now;
  const authenticate: Authenticate = (credentials) =>
    Promise.resolve(
      credentials.authorization === `Bearer ${KEY}`
        ? { ok: true, tenant: { ...TENANT, tokenId: randomUUID(), scopes } }
        : { ok: false, code: 'TOKEN_INVALID' },
    );
  const app = createApp({
    routes: [
      ...embedRoutes({ store: memory.store, environment: 'test', now }),
      defineTenantRoute({
        id: 'payouts',
        method: 'GET',
        path: '/v1/payouts',
        summary: 'A route an embed token can never reach',
        scope: 'payouts:read',
        response: { name: 'Payouts', schema: Payouts },
        handler: () => Promise.resolve({ ok: true }),
      }),
    ],
    authenticate: createTokenAuthenticatorOver(authenticate),
    authenticateEmbed: createEmbedAuthenticator({
      store: memory.store,
      environment: 'test',
      now,
    }),
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    addressRateLimit: allowEveryAddress,
    logger: memoryLogger(),
    now,
  });
  const mint = (body: unknown = request()) =>
    app.request('/v1/embed/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const minted = async (): Promise<string> => {
    const response = await mint();
    expect(response.status).toBe(201);
    return ((await response.json()) as { embedToken: string }).embedToken;
  };
  const withToken = (
    token: string,
    path = `/v1/embed/recipients/${RECIPIENT}`,
    origin: string | null = ORIGIN,
  ) =>
    app.request(path, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(origin === null ? {} : { origin }),
      },
    });
  return { app, memory, clock, mint, minted, withToken };
}

function request(change: Record<string, unknown> = {}) {
  return { recipientId: RECIPIENT, allowedOrigins: [ORIGIN], purpose: 'onboarding', ...change };
}

// The real API key authenticator's refusal of an embed token, in front of the stub.
function createTokenAuthenticatorOver(inner: Authenticate): Authenticate {
  const real = createTokenAuthenticator({
    store: {
      find: () => Promise.resolve(undefined),
      touchLastUsed: () => Promise.resolve(),
    },
    securityEvents: () => Promise.resolve(),
    environment: 'test',
    embedOrigins: [],
    logger: memoryLogger(),
  });
  return async (credentials, call) =>
    credentials.authorization === `Bearer ${KEY}`
      ? inner(credentials, call)
      : real(credentials, call);
}

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

describe('minting a token', () => {
  it('returns a token in the documented form, lasting 30 minutes', async () => {
    const response = await served().mint();
    expect(response.status).toBe(201);
    const body = (await response.json()) as { embedToken: string; expiresAt: string };
    expect(body.embedToken).toMatch(/^ujes_test_[a-z2-7]{59}$/);
    expect(new Date(body.expiresAt).getTime() - NOW.getTime()).toBe(EMBED_TOKEN_SECONDS * 1000);
    expect(EMBED_TOKEN_SECONDS).toBe(1800);
  });

  it('stores only the hash of the token', async () => {
    const api = served();
    const token = await api.minted();
    const [row] = api.memory.created;
    expect(row?.secretSha256).toHaveLength(32);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token.slice('ujes_test_'.length));
    expect(token.startsWith(row?.prefix ?? 'no row')).toBe(true);
  });

  it('needs the recipients:write scope', async () => {
    const response = await served(['recipients:read']).mint();
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('INSUFFICIENT_SCOPE');
  });

  it('refuses a recipient the tenant does not have', async () => {
    const response = await served().mint(request({ recipientId: randomUUID() }));
    expect(response.status).toBe(404);
  });

  it.each([
    ['no origins', { allowedOrigins: [] }],
    ['too many origins', { allowedOrigins: Array.from({ length: 11 }, () => ORIGIN) }],
    ['an origin with a path', { allowedOrigins: [`${ORIGIN}/page`] }],
    ['plain http', { allowedOrigins: ['http://widget.example.test'] }],
    ['text that is no origin', { allowedOrigins: ['widget'] }],
    ['another purpose', { purpose: 'identity' }],
    ['an unknown field', { scopes: ['payouts:write'] }],
  ])('refuses %s', async (_label, change) => {
    const response = await served().mint(request(change));
    expect(response.status).toBe(400);
  });

  it('allows plain http for a developer on localhost', async () => {
    const response = await served().mint(request({ allowedOrigins: ['http://localhost:3000'] }));
    expect(response.status).toBe(201);
  });
});

describe('using a token', () => {
  it('reaches its own recipient from an allowed origin, and the page can read the answer', async () => {
    const api = served();
    const response = await api.withToken(await api.minted());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recipientId: RECIPIENT, purpose: 'onboarding' });
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('vary')).toBe('origin');
  });

  it("another recipient's id returns 404", async () => {
    const api = served();
    const token = await api.minted();
    const other = await api.withToken(token, `/v1/embed/recipients/${OTHER_RECIPIENT}`);
    const unknown = await api.withToken(token, `/v1/embed/recipients/${randomUUID()}`);
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await other.text()).not.toContain(OTHER_RECIPIENT);
  });

  it('a request from an origin not listed is 403', async () => {
    const api = served();
    const response = await api.withToken(
      await api.minted(),
      `/v1/embed/recipients/${RECIPIENT}`,
      ELSEWHERE,
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('ORIGIN_NOT_ALLOWED');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a request with no origin is 403, because it is not the widget', async () => {
    const api = served();
    const response = await api.withToken(
      await api.minted(),
      `/v1/embed/recipients/${RECIPIENT}`,
      null,
    );
    expect(response.status).toBe(403);
  });

  it('an embed token on /v1/payouts is 401', async () => {
    const api = served();
    const token = await api.minted();
    for (const origin of [null, ORIGIN, ELSEWHERE]) {
      const response = await api.withToken(token, '/v1/payouts', origin);
      expect(response.status, String(origin)).toBe(401);
      expect(await codeOf(response)).toBe('TOKEN_INVALID');
    }
  });

  it('token is refused after expiry', async () => {
    const api = served();
    const token = await api.minted();
    api.clock.now = new Date(NOW.getTime() + EMBED_TOKEN_SECONDS * 1000 - 1);
    expect((await api.withToken(token)).status).toBe(200);
    api.clock.now = new Date(NOW.getTime() + EMBED_TOKEN_SECONDS * 1000);
    const response = await api.withToken(token);
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('EMBED_TOKEN_INVALID');
  });

  it('a token that has been used up is refused at once, with no cache to wait out', async () => {
    const api = served();
    const token = await api.minted();
    expect((await api.withToken(token)).status).toBe(200);
    for (const [hash, row] of api.memory.rows) {
      api.memory.rows.set(hash, { ...row, consumedAt: NOW });
    }
    expect((await api.withToken(token)).status).toBe(401);
  });

  it('every bad token reads the same', async () => {
    const api = served();
    const good = await api.minted();
    const wrongEnvironment = issueEmbedCredential('token', 'live').text;
    const unknown = issueEmbedCredential('token', 'test').text;
    const invite = issueEmbedCredential('invite', 'test').text;
    const brokenChecksum = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`;
    for (const token of [wrongEnvironment, unknown, invite, brokenChecksum, KEY, 'nonsense']) {
      const response = await api.withToken(token);
      expect(response.status, token.slice(0, 5)).toBe(401);
      expect(await codeOf(response)).toBe('EMBED_TOKEN_INVALID');
    }
  });

  it('has no credential at all as 401', async () => {
    const response = await served().app.request(`/v1/embed/recipients/${RECIPIENT}`, {
      headers: { origin: ORIGIN },
    });
    expect(response.status).toBe(401);
  });
});

describe('a browser asking first', () => {
  it('gets an answer on the widget routes', async () => {
    const response = await served().app.request(`/v1/embed/recipients/${RECIPIENT}`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('with no origin, gets no CORS headers', async () => {
    const response = await served().app.request(`/v1/embed/recipients/${RECIPIENT}`, {
      method: 'OPTIONS',
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('gets nothing on any other route', async () => {
    const response = await served().app.request('/v1/payouts', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never lets a page read the answer to an API key call', async () => {
    const api = served();
    const response = await api.app.request('/v1/embed/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify(request()),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
