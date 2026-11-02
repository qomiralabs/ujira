// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The webhook over HTTP, through the whole pipeline, with the real identity
// service on its in-memory ports and a fake Self that signs with a secret
// generated for each test.

import { randomBytes } from 'node:crypto';

import { Problem } from '@ujira/api-schema';
import type { Uuid } from '@ujira/chain-adapter';
import { SELF_SIGNATURE_HEADER, createSelfVerification } from '@ujira/identity';
import type { SelfWebhookRequest, SelfWebhookResponse } from '@ujira/identity';
import { TEST_NOW, selfWorld } from '@ujira/identity/testing';
import type { SelfDelivery, SelfWorld } from '@ujira/identity/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from '../app.js';
import { refuseAllCredentials } from '../auth.js';
import { RouteRegistryError } from '../errors.js';
import { memoryIdempotencyStore } from '../idempotency.js';
import { memoryLogger } from '../log.js';
import { allowEveryRequest } from '../rate-limit.js';
import { defineWebhookRoute } from '../route.js';

import { V1_ROUTES, v1Routes } from './index.js';
import { SELF_WEBHOOK_PATH } from './self-webhook.js';
import type { SelfWebhookHandler } from './self-webhook.js';
import { WALLET_PROOF_NOT_CONFIGURED } from './wallet-proofs.js';

function served(handler: SelfWebhookHandler, bodyLimitBytes?: number) {
  const logger = memoryLogger();
  const app = createApp({
    routes: v1Routes({ selfWebhook: handler, walletProof: WALLET_PROOF_NOT_CONFIGURED }),
    authenticate: refuseAllCredentials,
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    logger,
    ...(bodyLimitBytes === undefined ? {} : { bodyLimitBytes }),
  });
  const post = (
    delivery: SelfDelivery,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ) => {
    const signature = delivery.headers[SELF_SIGNATURE_HEADER];
    return app.request(SELF_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        ...headers,
        ...(signature === undefined ? {} : { [SELF_SIGNATURE_HEADER]: signature }),
      },
      body: delivery.rawBody,
    });
  };
  return { app, post, records: logger.records };
}

async function problemOf(response: Response): Promise<Problem> {
  const body = Problem.parse(await response.json());
  expect(body.status).toBe(response.status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  return body;
}

async function identityOf(w: SelfWorld): Promise<Uuid> {
  const session = await w.service.startSelfSession(w.ctx, {
    recipientId: w.recipient.id,
    returnUrl: 'https://app.example/back',
  });
  return session.identityId;
}

async function statusOf(w: SelfWorld, identityId: Uuid): Promise<string | undefined> {
  return (await w.store.identityById(identityId))?.status;
}

const Ack = z.strictObject({ result: z.string() });

describe('POST /v1/identity/self-webhook', () => {
  it('a bad signature returns 400 and changes nothing', async () => {
    const w = selfWorld();
    const identityId = await identityOf(w);
    const { post } = served(w.service);
    const body = w.provider.body({
      externalUuid: identityId,
      status: 'valid',
      completedAt: TEST_NOW,
    });

    const forged = w.provider.sign(body, TEST_NOW, { secret: randomBytes(32) });
    const response = await post(forged);
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('WEBHOOK_SIGNATURE_INVALID');

    const unsigned = await post({ rawBody: forged.rawBody, headers: {} });
    expect((await problemOf(unsigned)).code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await statusOf(w, identityId)).toBe('pending');
    expect(w.events.all()).toEqual([]);
  });

  it('the body is verified as sent: reformatting it after signing is refused', async () => {
    const w = selfWorld();
    const identityId = await identityOf(w);
    const { post } = served(w.service);
    const body = w.provider.body({
      externalUuid: identityId,
      status: 'valid',
      completedAt: TEST_NOW,
    });
    const signed = w.provider.sign(body, TEST_NOW);

    const reformatted: SelfDelivery = {
      headers: signed.headers,
      rawBody: new TextEncoder().encode(JSON.stringify(body, null, 2)),
    };
    expect((await problemOf(await post(reformatted))).code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await statusOf(w, identityId)).toBe('pending');

    // The same value in the bytes that were signed is accepted.
    expect(Ack.parse(await (await post(signed)).json())).toEqual({ result: 'applied' });
  });

  it('a genuine result is applied, and its replay is a duplicate', async () => {
    const w = selfWorld();
    const identityId = await identityOf(w);
    const { post } = served(w.service);
    const delivery = w.provider.deliver({
      externalUuid: identityId,
      status: 'valid',
      completedAt: TEST_NOW,
    });

    const first = await post(delivery);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('application/json');
    expect(await first.json()).toEqual({ result: 'applied' });
    expect(await statusOf(w, identityId)).toBe('verified');
    expect(await w.eligibility()).toMatchObject({ eligible: true, assurance: 'document_zk' });

    const replay = await post(delivery);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ result: 'duplicate' });
    expect(w.events.all()).toHaveLength(1);
  });

  it('an event for another environment or flow, and a signed body that is no result, are 400', async () => {
    const w = selfWorld();
    const identityId = await identityOf(w);
    const { post } = served(w.service);

    const live = w.provider.deliver({
      externalUuid: identityId,
      status: 'valid',
      environment: 'live',
      completedAt: TEST_NOW,
    });
    expect((await problemOf(await post(live))).code).toBe('WEBHOOK_REJECTED');
    const otherFlow = w.provider.deliver({
      externalUuid: identityId,
      status: 'valid',
      flowId: 'flow_other',
      completedAt: TEST_NOW,
    });
    expect((await problemOf(await post(otherFlow))).code).toBe('WEBHOOK_REJECTED');

    const notJson = w.provider.sign(null, TEST_NOW, { raw: '{not json' });
    expect((await problemOf(await post(notJson))).code).toBe('WEBHOOK_PAYLOAD_INVALID');
    expect(await statusOf(w, identityId)).toBe('pending');
  });

  it('the pipeline still holds the door: media type, size and method', async () => {
    const w = selfWorld();
    const delivery = w.provider.sign({}, TEST_NOW);
    const { app, post } = served(w.service, 8);

    const notJson = await post(delivery, { 'content-type': 'text/plain' });
    expect((await problemOf(notJson)).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const tooBig = await post({ ...delivery, rawBody: new Uint8Array(9) });
    expect((await problemOf(tooBig)).code).toBe('PAYLOAD_TOO_LARGE');
    const get = await app.request(SELF_WEBHOOK_PATH);
    expect((await problemOf(get)).code).toBe('METHOD_NOT_ALLOWED');
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('hands the handler the exact bytes and only the header it named', async () => {
    const seen: SelfWebhookRequest[] = [];
    const { post } = served({
      handleWebhook: (req): Promise<SelfWebhookResponse> => {
        seen.push(req);
        return Promise.resolve({ status: 200, body: { result: 'ignored' } });
      },
    });
    const rawBody = new TextEncoder().encode('  {"odd":   "spacing"}\n');
    await post(
      { rawBody, headers: { [SELF_SIGNATURE_HEADER]: 't=1,v1=x' } },
      {
        'content-type': 'application/json',
        authorization: 'Bearer should-not-travel',
        cookie: 'session=should-not-travel',
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.rawBody).toEqual(rawBody);
    expect(seen[0]?.headers).toEqual({ [SELF_SIGNATURE_HEADER]: 't=1,v1=x' });
    expect(seen[0]?.correlationId).toMatch(/^req_/);
  });

  it('logs the route and the outcome, and nothing of the delivery', async () => {
    const w = selfWorld();
    const identityId = await identityOf(w);
    const { post, records } = served(w.service);
    const nullifier = 'nullifier-of-a-real-person';
    await post(
      w.provider.deliver({
        externalUuid: identityId,
        status: 'valid',
        nullifier,
        completedAt: TEST_NOW,
      }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'request',
      route: SELF_WEBHOOK_PATH,
      status: 200,
    });
    const logged = JSON.stringify(records);
    for (const secret of [nullifier, identityId, 'PROOF-MARKER', 'CONTEXT-MARKER']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('a store failure is a 500 the provider retries, and the retry is applied', async () => {
    const w = selfWorld();
    const identityId = await identityOf(w);
    const delivery = w.provider.deliver({
      externalUuid: identityId,
      status: 'valid',
      completedAt: TEST_NOW,
    });
    let failing = true;
    const flakyStore = new Proxy(w.store, {
      get(target, key, receiver): unknown {
        if (failing && key === 'updateIdentity') {
          return () => Promise.reject(new Error('connection lost'));
        }
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const { post, records } = served(createSelfVerification({ ...w.ports, store: flakyStore }));

    const failed = await post(delivery);
    expect(failed.status).toBe(500);
    expect((await problemOf(failed)).code).toBe('INTERNAL');
    expect(records.some((record) => record.event === 'request_failed')).toBe(true);
    expect(w.events.all()).toEqual([]);

    failing = false;
    expect(await (await post(delivery)).json()).toEqual({ result: 'applied' });
    expect(await statusOf(w, identityId)).toBe('verified');
  });
});

describe('the served route table', () => {
  it('fails closed with 503 and Retry-After until Self is configured', async () => {
    const app = createApp({
      routes: V1_ROUTES,
      authenticate: refuseAllCredentials,
      rateLimit: allowEveryRequest,
      idempotency: memoryIdempotencyStore(),
      logger: memoryLogger(),
    });
    const w = selfWorld();
    const response = await app.request(SELF_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: w.provider.sign({}, TEST_NOW).rawBody,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect((await problemOf(response)).code).toBe('WEBHOOK_UNAVAILABLE');
  });
});

describe('defineWebhookRoute', () => {
  const base = {
    id: 'testWebhook',
    path: '/v1/test-webhook',
    summary: 'A test webhook',
    reason: 'Signed by the provider over its exact bytes.',
    headers: ['x-signature'],
    response: { name: 'Ok', schema: z.strictObject({ ok: z.boolean() }) },
    handler: () => Promise.resolve({ ok: true }),
  } as const;

  it('takes a body as bytes and lists what the pipeline can answer', () => {
    const route = defineWebhookRoute(base);
    expect(route.method).toBe('POST');
    expect(route.access.kind).toBe('public');
    expect(route.body).toBeNull();
    expect(route.rawBody).toEqual({ headers: ['x-signature'] });
    expect(route.errorStatuses).toEqual(expect.arrayContaining([400, 413, 415, 500, 503]));
  });

  it('must say what stands in for a key and name its headers in lower case', () => {
    expect(() => defineWebhookRoute({ ...base, reason: 'signed' })).toThrow(RouteRegistryError);
    expect(() => defineWebhookRoute({ ...base, headers: [] })).toThrow(RouteRegistryError);
    expect(() => defineWebhookRoute({ ...base, headers: ['X-Signature'] })).toThrow(
      RouteRegistryError,
    );
  });
});
