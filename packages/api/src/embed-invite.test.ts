// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Invites and tokens against the real table, through the role the API runs as, so the
// single use, the tenant checks and the erasure are the database's and not a fake's.

import { randomBytes, randomUUID } from 'node:crypto';

import { embedSessions, entryPoints, recipients } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createApp } from './app.js';
import type { Authenticate } from './auth.js';
import { createEmbedAuthenticator } from './embed-auth.js';
import { issueEmbedCredential } from './embed-token.js';
import { memoryLogger } from './log.js';
import { databaseEmbedStore } from './postgres-stores.js';
import { allowEveryRequest } from './rate-limit.js';
import { EMBED_INVITE_SECONDS, embedRoutes } from './routes/embed.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const ORIGIN = 'https://widget.example.test';
const ELSEWHERE = 'https://evil.example.test';

interface World {
  readonly principalId: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly key: string;
}

let database: TestDatabase;
let db: Database;
let a: World;
let b: World;
let app: ReturnType<typeof createApp>;

async function world(name: string): Promise<World> {
  const tenant = await db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, {
      name,
      projectName: `${name} project`,
      ownerUserId: randomUUID(),
    }),
  );
  const recipient = await db
    .tenant(tenant)
    .transaction((tx) => recipients.create(tx, { recipientRef: randomBytes(32), country: 'NG' }));
  return { ...tenant, recipientId: recipient.id, key: `key-${name}` };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function invite(from: World = a, allowedOrigins = [ORIGIN]): Promise<string> {
  const response = await post(
    '/v1/embed/invites',
    { recipientId: from.recipientId, allowedOrigins, purpose: 'onboarding' },
    { authorization: `Bearer ${from.key}` },
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { inviteSecret: string }).inviteSecret;
}

const exchange = (inviteSecret: string, origin: string | null = ORIGIN) =>
  post('/v1/embed/invites/exchange', { inviteSecret }, origin === null ? {} : { origin });

const tokenFrom = async (response: Response): Promise<string> =>
  ((await response.json()) as { embedToken: string }).embedToken;

const useToken = (token: string, recipientId: string, origin = ORIGIN) =>
  app.request(`/v1/embed/recipients/${recipientId}`, {
    headers: { authorization: `Bearer ${token}`, origin },
  });

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  a = await world('a');
  b = await world('b');
  const store = databaseEmbedStore(db);
  const authenticate: Authenticate = (credentials) => {
    for (const each of [a, b]) {
      if (credentials.authorization === `Bearer ${each.key}`) {
        return Promise.resolve({
          ok: true,
          tenant: {
            principalId: each.principalId,
            projectId: each.projectId,
            tokenId: randomUUID(),
            scopes: ['recipients:write'],
          },
        });
      }
    }
    return Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });
  };
  app = createApp({
    routes: embedRoutes({ store, environment: 'test' }),
    authenticate,
    authenticateEmbed: createEmbedAuthenticator({ store, environment: 'test' }),
    rateLimit: allowEveryRequest,
    logger: memoryLogger(),
  });
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe('an invite', () => {
  it('is in its own form, and lasts 72 hours', async () => {
    const before = Date.now();
    const response = await post(
      '/v1/embed/invites',
      { recipientId: a.recipientId, allowedOrigins: [ORIGIN], purpose: 'onboarding' },
      { authorization: `Bearer ${a.key}` },
    );
    const body = (await response.json()) as { inviteSecret: string; expiresAt: string };
    expect(body.inviteSecret).toMatch(/^ujei_test_[a-z2-7]{59}$/);
    const lasts = new Date(body.expiresAt).getTime() - before;
    expect(lasts).toBeGreaterThan((EMBED_INVITE_SECONDS - 60) * 1000);
    expect(lasts).toBeLessThanOrEqual((EMBED_INVITE_SECONDS + 60) * 1000);
  });

  it('exchanges for a token that reaches its recipient', async () => {
    const response = await exchange(await invite());
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const token = await tokenFrom(response);
    expect(token).toMatch(/^ujes_test_/);
    expect((await useToken(token, a.recipientId)).status).toBe(200);
  });

  it('second exchange of an invite secret is refused', async () => {
    const secret = await invite();
    expect((await exchange(secret)).status).toBe(200);
    const second = await exchange(secret);
    expect(second.status).toBe(401);
    expect(await codeOf(second)).toBe('EMBED_TOKEN_INVALID');
  });

  it('only one of many callers can exchange it', async () => {
    const secret = await invite();
    const responses = await Promise.all([exchange(secret), exchange(secret), exchange(secret)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401, 401]);
  });

  it('from an origin not listed is refused, and stays good for the right one', async () => {
    const secret = await invite();
    const refused = await exchange(secret, ELSEWHERE);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    expect((await exchange(secret, ORIGIN)).status).toBe(200);
  });

  it('with no origin is refused, and stays good', async () => {
    const secret = await invite();
    const refused = await exchange(secret, null);
    expect(refused.status).toBe(403);
    expect((await exchange(secret, ORIGIN)).status).toBe(200);
  });

  it('that has lapsed is refused', async () => {
    const issued = issueEmbedCredential('invite', 'test');
    await databaseEmbedStore(db).create(
      a,
      {
        kind: 'invite',
        secretSha256: issued.secretSha256,
        prefix: issued.prefix,
        recipientId: a.recipientId,
        purpose: 'onboarding',
        allowedOrigins: [ORIGIN],
        createdByToken: null,
        expiresAt: new Date(Date.now() - 1000),
      },
      { correlationId: 'test', signal: new AbortController().signal },
    );
    expect((await exchange(issued.text)).status).toBe(401);
  });

  it('that nobody made is refused, as is one for another environment or in another form', async () => {
    for (const secret of [
      issueEmbedCredential('invite', 'test').text,
      issueEmbedCredential('invite', 'live').text,
      issueEmbedCredential('token', 'test').text,
      'nonsense',
    ]) {
      expect((await exchange(secret)).status).toBe(401);
    }
  });

  it('cannot act as a token', async () => {
    const secret = await invite();
    expect((await useToken(secret, a.recipientId)).status).toBe(401);
    // Not by its hash either, had it been given the token's form.
    const asToken = `ujes${secret.slice('ujei'.length)}`;
    expect((await useToken(asToken, a.recipientId)).status).toBe(401);
    expect((await exchange(secret)).status).toBe(200);
  });
});

describe('a token', () => {
  it('cannot be exchanged, so nobody can renew it for ever', async () => {
    const token = await tokenFrom(await exchange(await invite()));
    expect((await exchange(token)).status).toBe(401);
    // Nor by its hash, had it been given the invite's form.
    expect((await exchange(`ujei${token.slice('ujes'.length)}`)).status).toBe(401);
    expect((await useToken(token, a.recipientId)).status).toBe(200);
  });

  it('keeps the origins of the invite it came from', async () => {
    const token = await tokenFrom(await exchange(await invite()));
    expect((await useToken(token, a.recipientId, ELSEWHERE)).status).toBe(403);
  });

  it('is stored only as a hash', async () => {
    const token = await tokenFrom(await exchange(await invite()));
    const rows = await db
      .tenant(a)
      .transaction((tx) =>
        tx.selectFrom('ujira.embed_sessions').selectAll().where('kind', '=', 'token').execute(),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(token.slice('ujes_test_'.length));
    for (const row of rows) expect(row.token_hash).toHaveLength(32);
  });

  it('stops working the moment its recipient is erased', async () => {
    const token = await tokenFrom(await exchange(await invite()));
    expect((await useToken(token, a.recipientId)).status).toBe(200);
    await db.tenant(a).transaction((tx) => embedSessions.consumeOpen(tx, a.recipientId));
    expect((await useToken(token, a.recipientId)).status).toBe(401);
  });
});

describe('between tenants', () => {
  it("a key cannot mint for another tenant's recipient", async () => {
    const response = await post(
      '/v1/embed/sessions',
      { recipientId: b.recipientId, allowedOrigins: [ORIGIN], purpose: 'onboarding' },
      { authorization: `Bearer ${a.key}` },
    );
    expect(response.status).toBe(404);
  });

  it("a key cannot make an invite for another tenant's recipient", async () => {
    const response = await post(
      '/v1/embed/invites',
      { recipientId: b.recipientId, allowedOrigins: [ORIGIN], purpose: 'onboarding' },
      { authorization: `Bearer ${a.key}` },
    );
    expect(response.status).toBe(404);
  });

  it("one tenant's token cannot reach another's recipient", async () => {
    const token = await tokenFrom(await exchange(await invite(a)));
    expect((await useToken(token, b.recipientId)).status).toBe(404);
  });

  it('a token made from an invite stays in the tenant of that invite', async () => {
    await exchange(await invite(b));
    const tokensFor = (tenant: World) =>
      db
        .tenant(tenant)
        .transaction((tx) =>
          tx
            .selectFrom('ujira.embed_sessions')
            .select('id')
            .where('kind', '=', 'token')
            .where('recipient_id', '=', b.recipientId)
            .execute(),
        );
    expect((await tokensFor(b)).length).toBeGreaterThan(0);
    expect(await tokensFor(a)).toEqual([]);
  });
});
