// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A destination submitted to the API goes through the same reader as
// onboarding. The recipient endpoints themselves come with their own issue;
// this mounts a route built the way they will be, on the real pipeline, so
// what a client sees for each kind of destination is pinned now.

import { randomUUID } from 'node:crypto';

import { Problem } from '@ujira/api-schema';
import {
  InvalidInputError,
  UNSUPPORTED_MEMO_DESTINATION_MESSAGE,
  UnsupportedMemoDestinationError,
} from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import type { Authenticate } from './auth.js';
import { RecipientDestinationBody, readRecipientDestination } from './destination.js';
import { toApiError } from './errors.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { allowEveryRequest } from './rate-limit.js';
import { defineTenantRoute } from './route.js';

const TENANT = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
};

const ACCOUNT = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5';
const MUXED_123456 = 'MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU';

const authenticate: Authenticate = (credentials) =>
  Promise.resolve(
    credentials.authorization === 'Bearer writer'
      ? { ok: true, tenant: { ...TENANT, tokenId: randomUUID(), scopes: ['payouts:write'] } }
      : { ok: false, code: 'TOKEN_INVALID' },
  );

const Bound = z.strictObject({
  principalId: z.string(),
  projectId: z.string(),
  network: z.string(),
  address: z.string(),
  tag: z.string().nullable(),
});

const recipientDestination = defineTenantRoute({
  id: 'checkRecipientDestination',
  method: 'POST',
  path: '/v1/recipients/destination',
  summary: 'Validate a recipient destination',
  scope: 'payouts:write',
  body: RecipientDestinationBody,
  response: { status: 201, name: 'BoundDestination', schema: Bound },
  errors: ['DESTINATION_INVALID'],
  handler: ({ body }, context) =>
    Promise.resolve({ ...context.tenant, ...readRecipientDestination(body) }),
});

function post(body: unknown): Promise<Response> {
  const app = createApp({
    routes: [recipientDestination],
    authenticate,
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    logger: memoryLogger(),
  });
  return Promise.resolve(
    app.request('/v1/recipients/destination', {
      method: 'POST',
      headers: {
        authorization: 'Bearer writer',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function problemOf(response: Response): Promise<Problem> {
  return Problem.parse(await response.json());
}

describe('recipients.destination.test.ts', () => {
  it('POST with a hash memo destination returns 422', async () => {
    const response = await post({
      network: 'stellar:testnet',
      address: ACCOUNT,
      memoType: 'hash',
      memo: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    });
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(problem.code).toBe('DESTINATION_INVALID');
    expect(problem.detail).toBe(UNSUPPORTED_MEMO_DESTINATION_MESSAGE);
    expect(problem.errors).toEqual([{ field: 'destination', code: 'invalid_value' }]);
    expect(JSON.stringify(problem)).not.toContain('AAECAwQF');
  });

  it('POST with a text memo, or an id that is not a number, returns 422 too', async () => {
    for (const [memoType, memo] of [
      ['text', 'order 1234'],
      ['id', 'order-1234'],
    ]) {
      const response = await post({ network: 'stellar:testnet', address: ACCOUNT, memoType, memo });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).detail).toBe(UNSUPPORTED_MEMO_DESTINATION_MESSAGE);
    }
  });

  it('POST with an id above 2^64 - 1 or a bad address returns 422 with the general detail', async () => {
    for (const body of [
      {
        network: 'stellar:testnet',
        address: ACCOUNT,
        memoType: 'id',
        memo: '18446744073709551616',
      },
      { network: 'stellar:testnet', address: `${ACCOUNT.slice(0, -1)}A` },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe('DESTINATION_INVALID');
      expect(problem.detail).not.toBe(UNSUPPORTED_MEMO_DESTINATION_MESSAGE);
    }
  });

  it('POST with a G address and an id memo binds the matching M address', async () => {
    const response = await post({
      network: 'stellar:testnet',
      address: ACCOUNT,
      memoType: 'id',
      memo: '123456',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ...TENANT,
      network: 'stellar:testnet',
      address: MUXED_123456,
      tag: '123456',
    });
  });

  it('POST with an unknown memo type or field is a 400 from the body schema', async () => {
    for (const body of [
      { network: 'stellar:testnet', address: ACCOUNT, memoType: 'picture', memo: '1' },
      { network: 'stellar:testnet', address: ACCOUNT, extra: 1 },
      { network: 'stellar:mainnet', address: ACCOUNT },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  it('maps only destination refusals to DESTINATION_INVALID', () => {
    expect(toApiError(new InvalidInputError()).code).toBe('INVALID_REQUEST');
    const refused = toApiError(
      new UnsupportedMemoDestinationError({ network: 'stellar:testnet', path: 'destination.memo' }),
    );
    expect(refused.code).toBe('DESTINATION_INVALID');
    expect(refused.status).toBe(422);
  });
});
