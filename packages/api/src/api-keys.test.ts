// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Who can reach the key routes, and what they accept. The stores here throw, unless a
// test gives it one, so a route that lets something through fails loudly.

import { randomUUID } from 'node:crypto';

import { Problem } from '@ujira/api-schema';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKeyRecords, StoredApiKey } from './api-key-service.js';
import { createApiKeyEndpoints } from './api-key-service.js';
import { createApp } from './app.js';
import type { AuthenticateMember, MemberRole } from './auth.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { allowEveryRequest } from './rate-limit.js';
import { ApiKeyIssued, apiKeyRoutes } from './routes/api-keys.js';
import { issueToken, parseToken } from './token.js';

const TENANT = { principalId: randomUUID(), projectId: randomUUID() };
const KEY_ID = randomUUID();
const NOW = new Date('2026-11-05T12:00:00Z');

const unreachable = (): Promise<never> => Promise.reject(new Error('the store was reached'));
const NO_STORE: ApiKeyRecords = { create: unreachable, rotate: unreachable, revoke: unreachable };

function storedFrom(key: {
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
}): StoredApiKey {
  return {
    id: KEY_ID,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    expiresAt: key.expiresAt,
    revokedAt: null,
    rotatedFromId: null,
    createdAt: NOW,
  };
}

const STORING: ApiKeyRecords = {
  create: (_tenant, key) => Promise.resolve(storedFrom(key)),
  rotate: () => Promise.resolve({ outcome: 'not_found' }),
  revoke: () => Promise.resolve(undefined),
};

function member(role: MemberRole, secondsSinceStepUp: number | null): AuthenticateMember {
  return () =>
    Promise.resolve({
      ok: true,
      member: {
        ...TENANT,
        userId: randomUUID(),
        role,
        steppedUpAt:
          secondsSinceStepUp === null ? null : new Date(NOW.getTime() - secondsSinceStepUp * 1000),
      },
    });
}

const OWNER = member('owner', 10);
const logger = memoryLogger();

function served(authenticateMember: AuthenticateMember | undefined, records = NO_STORE) {
  const app = createApp({
    routes: apiKeyRoutes(createApiKeyEndpoints({ records, environment: 'test', now: () => NOW })),
    authenticate: () => Promise.reject(new Error('a member route asked the key authenticator')),
    ...(authenticateMember === undefined ? {} : { authenticateMember }),
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    logger,
    now: () => NOW,
  });
  return (path: string, body: unknown, authorization?: string) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify(body),
    });
}

async function codeOf(response: Response): Promise<string> {
  return Problem.parse(await response.json()).code;
}

const CREATE = { name: 'Billing', preset: 'payouts', expiresInDays: 90 };

describe('a key cannot manage keys', () => {
  const routes = [
    ['rotate', `/v1/api-keys/${KEY_ID}/rotate`, { overlapHours: 24 }],
    ['revoke', `/v1/api-keys/${KEY_ID}/revoke`, undefined],
    ['create', '/v1/api-keys', CREATE],
  ] as const;

  it('an API key calling rotate is 403', async () => {
    const session = vi.fn(OWNER);
    const { token } = issueToken('test');
    const response = await served(session)(
      `/v1/api-keys/${KEY_ID}/rotate`,
      { overlapHours: 24 },
      `Bearer ${token}`,
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('INSUFFICIENT_SCOPE');
    // Refused for being a key, before a session or the store was looked at.
    expect(session).not.toHaveBeenCalled();
  });

  it.each(routes)('%s refuses a key, whatever it holds', async (_name, path, body) => {
    const { token } = issueToken('live');
    const response = await served(OWNER)(path, body, `Bearer ${token}`);
    expect(response.status).toBe(403);
  });

  it('refuses something shaped like a key that would not even parse', async () => {
    const response = await served(OWNER)(
      `/v1/api-keys/${KEY_ID}/rotate`,
      { overlapHours: 24 },
      'bearer ujk_live_nonsense',
    );
    expect(response.status).toBe(403);
  });
});

describe('who may manage keys', () => {
  it.each(['developer', 'viewer'] as const)('a %s may not', async (role) => {
    const response = await served(member(role, 10))('/v1/api-keys', CREATE);
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('INSUFFICIENT_SCOPE');
  });

  it.each(['owner', 'admin'] as const)('an %s may', async (role) => {
    const response = await served(member(role, 10), STORING)('/v1/api-keys', CREATE);
    expect(response.status).toBe(201);
  });

  it('no session is 401', async () => {
    const refused: AuthenticateMember = () => Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });
    expect((await served(refused)('/v1/api-keys', CREATE)).status).toBe(401);
  });

  it('with sessions not set up, every route refuses', async () => {
    expect((await served(undefined)('/v1/api-keys', CREATE)).status).toBe(401);
  });

  it('a session that returns a malformed tenant is our bug, and runs nothing', async () => {
    const broken: AuthenticateMember = () =>
      Promise.resolve({
        ok: true,
        member: {
          principalId: 'not-a-uuid',
          projectId: TENANT.projectId,
          userId: randomUUID(),
          role: 'owner',
          steppedUpAt: NOW,
        },
      });
    expect((await served(broken)('/v1/api-keys', CREATE)).status).toBe(500);
  });
});

describe('a fresh second factor', () => {
  it.each([
    ['301 seconds old', 301],
    ['never passed', null],
    ['from a clock ahead of ours', -60],
  ] as const)('%s is refused', async (_name, seconds) => {
    const response = await served(member('owner', seconds))('/v1/api-keys', CREATE);
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('STEP_UP_REQUIRED');
  });

  it.each([[0], [300]] as const)('%i seconds old is accepted', async (seconds) => {
    const response = await served(member('owner', seconds), STORING)('/v1/api-keys', CREATE);
    expect(response.status).toBe(201);
  });
});

describe('POST /v1/api-keys', () => {
  it('no expiry returns 422', async () => {
    const response = await served(OWNER)('/v1/api-keys', { name: 'Billing', preset: 'full' });
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe('API_KEY_EXPIRY_INVALID');
  });

  it.each([[731], [0], [-1]] as const)('%i days returns 422', async (expiresInDays) => {
    const response = await served(OWNER)('/v1/api-keys', { ...CREATE, expiresInDays });
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe('API_KEY_EXPIRY_INVALID');
  });

  it('730 days is the longest', async () => {
    const response = await served(OWNER, STORING)('/v1/api-keys', {
      ...CREATE,
      expiresInDays: 730,
    });
    const issued = ApiKeyIssued.parse(await response.json());
    expect(new Date(issued.expiresAt).getTime()).toBe(NOW.getTime() + 730 * 86_400_000);
  });

  it('shows the whole key, and does not log it', async () => {
    logger.records.length = 0;
    const response = await served(OWNER, STORING)('/v1/api-keys', CREATE);
    const issued = ApiKeyIssued.parse(await response.json());
    const parsed = parseToken(issued.key);
    expect(parsed?.environment).toBe('test');
    expect(parsed?.prefix).toBe(issued.prefix);
    expect(JSON.stringify(logger.records)).not.toContain(issued.key);
    expect(JSON.stringify(logger.records)).not.toContain(parsed?.secret);
  });

  it('expands a preset', async () => {
    const response = await served(OWNER, STORING)('/v1/api-keys', {
      ...CREATE,
      preset: 'read_only',
    });
    const { scopes } = ApiKeyIssued.parse(await response.json());
    expect(scopes).toContain('payouts:read');
    expect(scopes.every((scope) => scope.endsWith(':read'))).toBe(true);
  });

  it('takes named scopes', async () => {
    const response = await served(OWNER, STORING)('/v1/api-keys', {
      name: 'Billing',
      scopes: ['payouts:read'],
      expiresInDays: 90,
    });
    expect(ApiKeyIssued.parse(await response.json()).scopes).toEqual(['payouts:read']);
  });

  it.each([
    ['both scopes and a preset', { ...CREATE, scopes: ['payouts:read'] }],
    ['neither', { name: 'Billing', expiresInDays: 90 }],
    ['no scopes', { name: 'Billing', scopes: [], expiresInDays: 90 }],
    ['a scope off the list', { name: 'Billing', scopes: ['keys:write'], expiresInDays: 90 }],
    ['a scope twice', { name: 'B', scopes: ['payouts:read', 'payouts:read'], expiresInDays: 9 }],
    ['no name', { preset: 'full', expiresInDays: 90 }],
    ['a blank name', { ...CREATE, name: '   ' }],
    ['a name with a control character', { ...CREATE, name: 'a\u0000b' }],
    ['a tenant of its own', { ...CREATE, principalId: randomUUID() }],
    ['a fraction of a day', { ...CREATE, expiresInDays: 1.5 }],
  ] as const)('refuses %s', async (_name, body) => {
    expect((await served(OWNER)('/v1/api-keys', body)).status).toBe(400);
  });

  it('at the limit is 422', async () => {
    const full: ApiKeyRecords = { ...STORING, create: () => Promise.resolve(null) };
    const response = await served(OWNER, full)('/v1/api-keys', CREATE);
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe('API_KEY_LIMIT_REACHED');
  });
});

describe('POST /v1/api-keys/{id}/rotate', () => {
  it.each([[169], [-1], [1.5]] as const)('an overlap of %d is refused', async (overlapHours) => {
    const response = await served(OWNER)(`/v1/api-keys/${KEY_ID}/rotate`, { overlapHours });
    expect(response.status).toBe(400);
  });

  it('a malformed id is 404', async () => {
    const response = await served(OWNER)('/v1/api-keys/nope/rotate', { overlapHours: 1 });
    expect(response.status).toBe(404);
  });
});
