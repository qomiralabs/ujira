// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The recipient endpoints on the real tables, as the role the API runs as: personal
// data reaches only recipient_pii, as ciphertext, and nothing of it reaches the
// stored idempotency answer.

import { randomBytes, randomUUID } from 'node:crypto';

import { RecipientDetail, RecipientPage } from '@ujira/api-schema';
import { entryPoints } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createApp } from './app.js';
import type { Authenticate, Tenant } from './auth.js';
import { memoryLogger } from './log.js';
import { databaseIdempotencyStore, databaseRecipientRecords } from './postgres-stores.js';
import { allowEveryRequest } from './rate-limit.js';
import { createRecipientEndpoints } from './recipient-service.js';
import { ACCOUNT, ISSUER, PERSON, testCipher } from './recipients.test-support.js';
import { recipientRoutes } from './routes/recipients.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

let database: TestDatabase;
let db: Database;
let alpha: Tenant;
let bravo: Tenant;

async function newTenant(name: string): Promise<Tenant> {
  return db.unscoped((tx) =>
    entryPoints.createPrincipal(tx, { name, projectName: 'Main', ownerUserId: randomUUID() }),
  );
}

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 4);
  alpha = await newTenant('Alpha');
  bravo = await newTenant('Bravo');
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

function served() {
  const authenticate: Authenticate = (credentials) => {
    const token = credentials.authorization?.replace(/^Bearer /, '');
    const tenant = token === 'alpha' ? alpha : token === 'bravo' ? bravo : null;
    if (tenant === null) return Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });
    return Promise.resolve({
      ok: true,
      tenant: {
        principalId: tenant.principalId,
        projectId: tenant.projectId,
        tokenId: randomUUID(),
        scopes: ['recipients:read', 'recipients:write'],
      },
    });
  };
  const app = createApp({
    routes: recipientRoutes(
      createRecipientEndpoints({
        records: databaseRecipientRecords(db),
        cipher: testCipher(),
        refSalt: randomBytes(32),
        neverPayable: () => [ISSUER],
      }),
    ),
    authenticate,
    rateLimit: allowEveryRequest,
    idempotency: databaseIdempotencyStore(db),
    logger: memoryLogger(),
  });
  return (method: string, path: string, body?: unknown, token = 'alpha', key = randomUUID()) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': key }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const wallet = {
  method: 'stellar_wallet',
  destination: { network: 'stellar:testnet', address: ACCOUNT },
};

describe('against the tables', () => {
  it('stores, reads back and keeps apart', async () => {
    const call = served();
    const created = (await (
      await call('POST', '/v1/recipients', { country: 'KE', personal: PERSON })
    ).json()) as { id: string };
    expect((await call('POST', `/v1/recipients/${created.id}/methods`, wallet)).status).toBe(201);

    const detail = RecipientDetail.parse(
      await (await call('GET', `/v1/recipients/${created.id}`)).json(),
    );
    expect(detail.personal).toEqual(PERSON);
    expect(detail.methods.map((method) => method.destination)).toEqual([ACCOUNT]);

    expect((await call('GET', `/v1/recipients/${created.id}`, undefined, 'bravo')).status).toBe(
      404,
    );
    expect(
      (await call('POST', `/v1/recipients/${created.id}/methods`, wallet, 'bravo')).status,
    ).toBe(404);

    const list = RecipientPage.parse(await (await call('GET', '/v1/recipients')).json());
    expect(list.items.map((item) => item.id)).toContain(created.id);
    const others = RecipientPage.parse(
      await (await call('GET', '/v1/recipients', undefined, 'bravo')).json(),
    );
    expect(others.items.map((item) => item.id)).not.toContain(created.id);
  });

  it('a reference recognizes the same recipient, and the first personal data stands', async () => {
    const call = served();
    const reference = randomUUID();
    const first = (await (
      await call('POST', '/v1/recipients', { country: 'KE', reference, personal: PERSON })
    ).json()) as { id: string };
    const second = (await (
      await call('POST', '/v1/recipients', {
        country: 'KE',
        reference,
        personal: { fullName: 'Somebody Else' },
      })
    ).json()) as { id: string };
    expect(second.id).toBe(first.id);
    const detail = RecipientDetail.parse(
      await (await call('GET', `/v1/recipients/${first.id}`)).json(),
    );
    expect(detail.personal).toEqual(PERSON);
  });

  it('holds a tag at full width', async () => {
    const call = served();
    const { id } = (await (await call('POST', '/v1/recipients', { country: 'KE' })).json()) as {
      id: string;
    };
    const added = await call('POST', `/v1/recipients/${id}/methods`, {
      method: 'stellar_wallet',
      destination: {
        network: 'stellar:testnet',
        address: ACCOUNT,
        memoType: 'id',
        memo: '18446744073709551615',
      },
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ tag: '18446744073709551615' });
  });

  it('replays over the real idempotency table, with nothing personal in the answer', async () => {
    const call = served();
    const key = randomUUID();
    const body = { country: 'KE', personal: PERSON };
    const first = await call('POST', '/v1/recipients', body, 'alpha', key);
    const second = await call('POST', '/v1/recipients', body, 'alpha', key);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    const text = await second.text();
    expect(text).toBe(await first.text());
    for (const value of Object.values(PERSON)) expect(text).not.toContain(value);
  });
});
