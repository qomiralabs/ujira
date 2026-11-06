// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The recipient endpoints through the whole pipeline. Tests only: this file is left
// out of the build. The cipher is real AES-256-GCM under a key made per test, bound
// to the tenant and the recipient, as the production one will be.

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

import { Problem } from '@ujira/api-schema';

import { createApp } from './app.js';
import type { Authenticate, Tenant } from './auth.js';
import { memoryIdempotencyStore } from './idempotency.js';
import type { FinishRequest, IdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { allowEveryRequest } from './rate-limit.js';
import { createRecipientEndpoints } from './recipient-service.js';
import type {
  EncryptedValue,
  PersonalDataCipher,
  RecipientRecords,
  StoredMethod,
  StoredRecipient,
} from './recipient-service.js';
import { recipientRoutes } from './routes/recipients.js';

export const TENANT_A: Tenant = { principalId: randomUUID(), projectId: randomUUID() };
export const TENANT_B: Tenant = { principalId: randomUUID(), projectId: randomUUID() };

export function testCipher(): PersonalDataCipher & { readonly decrypted: () => number } {
  const key = randomBytes(32);
  let opened = 0;
  const aad = (tenant: Tenant, id: string) =>
    Buffer.from(JSON.stringify([tenant.principalId, tenant.projectId, id]));
  return {
    decrypted: () => opened,
    encrypt: (tenant, id, plaintext) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(tenant, id));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return Promise.resolve({ ciphertext, nonce });
    },
    decrypt: (tenant, id, value) => {
      opened += 1;
      const decipher = createDecipheriv('aes-256-gcm', key, value.nonce);
      decipher.setAAD(aad(tenant, id));
      decipher.setAuthTag(value.ciphertext.subarray(-16));
      return Promise.resolve(
        Buffer.concat([decipher.update(value.ciphertext.subarray(0, -16)), decipher.final()]),
      );
    },
  };
}

export function memoryRecipientRecords(): RecipientRecords & {
  readonly storedPersonal: (id: string) => EncryptedValue | undefined;
} {
  const tenantOf = (t: Tenant) => `${t.principalId}:${t.projectId}`;
  const rows = new Map<string, { tenant: string; row: StoredRecipient; ref: string }>();
  const personal = new Map<string, EncryptedValue>();
  const methods: { tenant: string; row: StoredMethod }[] = [];
  const visible = (tenant: Tenant) =>
    [...rows.values()].filter((entry) => entry.tenant === tenantOf(tenant));
  return {
    storedPersonal: (id) => personal.get(id),
    createOnce: (tenant, input) => {
      const ref = input.recipientRef.toString('hex');
      const held = visible(tenant).find((entry) => entry.ref === ref);
      if (held !== undefined) return Promise.resolve(held.row);
      const row: StoredRecipient = {
        id: input.id,
        country: input.country,
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      };
      rows.set(input.id, { tenant: tenantOf(tenant), row, ref });
      if (input.personal !== null) personal.set(input.id, input.personal);
      return Promise.resolve(row);
    },
    find: (tenant, id) => {
      const entry = rows.get(id);
      return Promise.resolve(entry?.tenant === tenantOf(tenant) ? entry.row : undefined);
    },
    list: (tenant, page) => {
      const sorted = visible(tenant)
        .map((entry) => entry.row)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .filter((row) => page.after === undefined || row.id > page.after);
      const items = sorted.slice(0, page.limit);
      return Promise.resolve({
        items,
        next: sorted.length > page.limit ? (items.at(-1)?.id ?? null) : null,
      });
    },
    personal: (tenant, id) =>
      Promise.resolve(rows.get(id)?.tenant === tenantOf(tenant) ? personal.get(id) : undefined),
    methods: (tenant, id) =>
      Promise.resolve(
        methods
          .filter((entry) => entry.tenant === tenantOf(tenant) && entry.row.recipientId === id)
          .map((entry) => entry.row),
      ),
    addMethod: (tenant, input) => {
      const row: StoredMethod = {
        id: randomUUID(),
        recipientId: input.recipientId,
        method: input.method,
        rail: input.rail,
        chain: input.chain,
        destinationAddress: input.destinationAddress,
        destinationTag: input.destinationTag,
        hasDetails: input.details !== null,
        status: 'active',
      };
      methods.push({ tenant: tenantOf(tenant), row });
      return Promise.resolve(row);
    },
  };
}

/** Keeps every answer the idempotency store is given, to look at what it would hold. */
export function recordingIdempotencyStore(): IdempotencyStore & {
  readonly stored: FinishRequest[];
} {
  const inner = memoryIdempotencyStore();
  const stored: FinishRequest[] = [];
  return {
    ...inner,
    stored,
    complete: (tenant, request, call) => {
      stored.push(request);
      return inner.complete(tenant, request, call);
    },
  };
}

export function recipientWorld(
  records: RecipientRecords & {
    readonly storedPersonal?: (id: string) => EncryptedValue | undefined;
  } = memoryRecipientRecords(),
) {
  const logger = memoryLogger();
  const cipher = testCipher();
  const idempotency = recordingIdempotencyStore();
  const authenticate: Authenticate = (credentials) => {
    const token = credentials.authorization?.replace(/^Bearer /, '');
    const tenant = token === 'alpha' ? TENANT_A : token === 'bravo' ? TENANT_B : null;
    if (tenant === null) return Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });
    return Promise.resolve({
      ok: true,
      tenant: {
        ...tenant,
        tokenId: randomUUID(),
        scopes: ['recipients:read', 'recipients:write'],
      },
    });
  };
  const deps = { records, cipher, refSalt: randomBytes(32), neverPayable: () => [ISSUER] };
  const appOn = (store: IdempotencyStore = idempotency) =>
    createApp({
      routes: recipientRoutes(createRecipientEndpoints(deps)),
      authenticate,
      rateLimit: allowEveryRequest,
      idempotency: store,
      logger,
    });
  const app = appOn();
  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        authorization: 'Bearer alpha',
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const newRecipient = async (body: unknown = { country: 'KE' }): Promise<string> => {
    const response = await request('POST', '/v1/recipients', body);
    return ((await response.json()) as { id: string }).id;
  };
  return { app, appOn, logger, cipher, idempotency, records, request, newRecipient };
}

export async function problemOf(response: Response): Promise<Problem> {
  return Problem.parse(await response.json());
}

export const PERSON = Object.freeze({
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+254700000000',
});

export const ACCOUNT = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5';
export const MUXED_123456 = 'MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU';
/** The settlement asset's issuer on testnet, where a transfer of the asset is burned. */
export const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
