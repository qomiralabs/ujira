// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reading the address, then the limit in the pipeline with a fake store, a real
// socket, and finally a real database through two API instances.

import { Problem } from '@ujira/api-schema';
import { DatabaseUnavailableError } from '@ujira/db';
import type { Database } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import { refuseAllCredentials } from './auth.js';
import { clientAddress, normalizeAddress } from './client-address.js';
import type { TrustedProxy } from './client-address.js';
import { RouteRegistryError } from './errors.js';
import { memoryLogger } from './log.js';
import { withOpenApiRoute } from './openapi.js';
import { databaseBucketStore } from './postgres-stores.js';
import {
  ADDRESS_LIMIT_DEFAULTS,
  addressBucketKey,
  allowEveryRequest,
  createAddressRateLimit,
} from './rate-limit.js';
import type {
  AddressLimitGroup,
  BucketRequest,
  BucketResult,
  BucketStore,
  RateLimitRule,
} from './rate-limit.js';
import { definePublicRoute, defineWebhookRoute } from './route.js';
import type { Route } from './route.js';
import { V1_ROUTES } from './routes/index.js';
import { startServer } from './serve.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const HMAC_KEY = new Uint8Array(32).fill(7);
const PROXY: TrustedProxy = { header: 'x-forwarded-for', hop: 1 };
const SECOND_PROXY: TrustedProxy = { header: 'x-forwarded-for', hop: 2 };

function peerEnv(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress } } };
}

function forwarded(value: string | null, peer?: string) {
  const headers = new Headers(value === null ? {} : { 'x-forwarded-for': value });
  return { headers, peer };
}

describe('normalizeAddress', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(normalizeAddress('203.0.113.9')).toBe('203.0.113.9');
  });

  it('reads an IPv4 client on a dual stack socket as that IPv4 client', () => {
    expect(normalizeAddress('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeAddress('::ffff:cb00:7109')).toBe('203.0.113.9');
    expect(normalizeAddress('::FFFF:203.0.113.9')).toBe('203.0.113.9');
  });

  it('cuts IPv6 to its /64', () => {
    expect(normalizeAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(normalizeAddress('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(normalizeAddress('2001:db8:1:3::9')).toBe('2001:db8:1:3::/64');
  });

  it('gives every spelling of one address the same answer', () => {
    const expected = '2001:db8:0:1::/64';
    for (const spelling of [
      '2001:db8:0:1::',
      '2001:DB8:0:1::',
      '2001:0db8:0000:0001:0000:0000:0000:0000',
      '2001:db8:0:1:0:0:0:0',
      '2001:db8:0:1::0.0.0.0',
    ]) {
      expect(normalizeAddress(spelling), spelling).toBe(expected);
    }
    expect(normalizeAddress('::1')).toBe('0:0:0:0::/64');
  });

  it('refuses what is not an address', () => {
    for (const junk of [
      '',
      'unknown',
      'not an address',
      '999.0.0.1',
      '01.2.3.4',
      '1.2.3.4:443',
      '[::1]',
      'for=1.2.3.4',
      '1.2.3.4/24',
      'fe80::1%eth0',
    ]) {
      expect(normalizeAddress(junk), junk).toBeNull();
    }
  });

  it('never gives two IPv6 addresses in one /64 different answers', () => {
    for (const hosts of [
      ['1:2:3:4', 'ffff:ffff:ffff:ffff'],
      ['0:0:0:1', 'a:b:c:d'],
      ['dead:beef:0:1', '0:0:0:0'],
    ]) {
      const [first = '', second = ''] = hosts;
      expect(normalizeAddress(`2001:db8:aa:bb:${first}`)).toBe('2001:db8:aa:bb::/64');
      expect(normalizeAddress(`2001:db8:aa:bb:${second}`)).toBe('2001:db8:aa:bb::/64');
    }
  });
});

describe('clientAddress', () => {
  it('with no trusted proxy, reads the peer and ignores the header', () => {
    expect(clientAddress(forwarded('198.51.100.1', '203.0.113.9'), null)).toBe('203.0.113.9');
  });

  it('with no trusted proxy and no peer, has no address', () => {
    expect(clientAddress(forwarded('198.51.100.1'), null)).toBeNull();
  });

  it('with a trusted proxy, reads the configured hop from the right', () => {
    const list = '198.51.100.1, 198.51.100.2, 198.51.100.3';
    expect(clientAddress(forwarded(list), PROXY)).toBe('198.51.100.3');
    expect(clientAddress(forwarded(list), SECOND_PROXY)).toBe('198.51.100.2');
  });

  it('with a trusted proxy, ignores the peer, which is only the proxy', () => {
    expect(clientAddress(forwarded('198.51.100.3', '10.0.0.1'), PROXY)).toBe('198.51.100.3');
  });

  it('never wraps round to a caller entry when there are too few hops', () => {
    expect(clientAddress(forwarded('198.51.100.1'), SECOND_PROXY)).toBeNull();
  });

  it('has no address when the entry is missing or malformed', () => {
    expect(clientAddress(forwarded(null), PROXY)).toBeNull();
    expect(clientAddress(forwarded(''), PROXY)).toBeNull();
    expect(clientAddress(forwarded('198.51.100.1, junk'), PROXY)).toBeNull();
    expect(clientAddress(forwarded('198.51.100.1,'), PROXY)).toBeNull();
  });

  it('reads a header repeated by the caller as one list, still from the right', () => {
    const headers = new Headers();
    headers.append('x-forwarded-for', '198.51.100.66');
    headers.append('x-forwarded-for', '198.51.100.3');
    expect(clientAddress({ headers, peer: undefined }, PROXY)).toBe('198.51.100.3');
  });
});

describe('addressBucketKey', () => {
  const key = addressBucketKey('webhook', '203.0.113.9', HMAC_KEY);

  it('fits the bucket table and holds no address', () => {
    expect(key).toMatch(/^webhook:[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.9');
  });

  it('depends on the secret, so the address cannot be found by trying them all', () => {
    expect(addressBucketKey('webhook', '203.0.113.9', new Uint8Array(32).fill(8))).not.toBe(key);
  });

  it('differs per group, per address, and for no address at all', () => {
    expect(addressBucketKey('invite_exchange', '203.0.113.9', HMAC_KEY).split(':')[1]).not.toBe(
      key.split(':')[1],
    );
    expect(addressBucketKey('webhook', '203.0.113.8', HMAC_KEY)).not.toBe(key);
    expect(addressBucketKey('webhook', null, HMAC_KEY)).not.toBe(key);
  });
});

// A bucket per key with a real count, so refusals here come from the buckets the
// pipeline really chose, and a different bucket really does get its own tokens.
function countingStore(capacityOverride?: number) {
  const left = new Map<string, number>();
  const asked: BucketRequest[] = [];
  const store: BucketStore = {
    take: (buckets) => {
      const results: BucketResult[] = buckets.map((bucket) => {
        asked.push(bucket);
        const before = left.get(bucket.key) ?? capacityOverride ?? bucket.capacity;
        const allowed = before >= 1;
        const tokens = allowed ? before - 1 : before;
        left.set(bucket.key, tokens);
        return { key: bucket.key, allowed, tokens };
      });
      return Promise.resolve(results);
    },
  };
  return { store, asked };
}

const Ok = z.strictObject({ ok: z.literal(true) });

function publicRoute(group: AddressLimitGroup, run: () => void = () => undefined): Route {
  return definePublicRoute({
    id: `limited_${group}`,
    method: 'POST',
    path: `/v1/limited/${group}`,
    summary: 'A limited route',
    reason: 'Only here so a test can limit it.',
    addressLimit: group,
    body: z.strictObject({ value: z.string() }),
    response: { name: 'Ok', schema: Ok },
    handler: () => {
      run();
      return Promise.resolve({ ok: true as const });
    },
  });
}

function pipeline(options: {
  readonly routes: readonly Route[];
  readonly proxy?: TrustedProxy;
  readonly store: BucketStore;
}) {
  const logger = memoryLogger();
  const app = createApp({
    routes: options.routes,
    authenticate: refuseAllCredentials,
    rateLimit: allowEveryRequest,
    addressRateLimit: createAddressRateLimit(options.store, HMAC_KEY),
    ...(options.proxy === undefined ? {} : { trustedProxy: options.proxy }),
    logger,
  });
  return { app, logger };
}

function post(path: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify({ value: path }),
    headers: { 'content-type': 'application/json', ...headers },
  };
}

// A body that counts its reads, to tell a refusal before the body from one after it.
function watchedBody() {
  let reads = 0;
  // No buffer, because a stream with one pulls as soon as it is built, unread.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode('{"value":"x"}'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init = {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { 'content-type': 'application/json' },
  } as RequestInit;
  return { init, reads: () => reads };
}

describe('the limit in the pipeline', () => {
  const route = publicRoute('invite_exchange');
  const path = '/v1/limited/invite_exchange';

  it('with no trusted proxy, a different forwarded header on each request is still refused', async () => {
    const { store } = countingStore(2);
    const { app } = pipeline({ routes: [route], store });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await app.request(
        path,
        post(path, {
          'x-forwarded-for': `198.51.100.${String(i)}`,
          'x-real-ip': `192.0.2.${String(i)}`,
        }),
        peerEnv('203.0.113.9'),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it('with no trusted proxy, two peers get two buckets', async () => {
    const { store } = countingStore(1);
    const { app } = pipeline({ routes: [route], store });
    const statuses: number[] = [];
    for (const peer of ['203.0.113.1', '203.0.113.2', '203.0.113.1']) {
      statuses.push((await app.request(path, post(path), peerEnv(peer))).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('with a trusted proxy, the configured hop picks the bucket', async () => {
    const { store } = countingStore(1);
    const { app } = pipeline({ routes: [route], proxy: PROXY, store });
    const send = (value: string) =>
      app.request(path, post(path, { 'x-forwarded-for': value }), peerEnv('10.0.0.1'));
    expect((await send('198.51.100.1')).status).toBe(200);
    expect((await send('198.51.100.2')).status).toBe(200);
    expect((await send('198.51.100.1')).status).toBe(429);
  });

  it('with a trusted proxy, an entry a caller added further left does not pick the bucket', async () => {
    const { store } = countingStore(1);
    const { app } = pipeline({ routes: [route], proxy: PROXY, store });
    const send = (spoofed: string) =>
      app.request(
        path,
        post(path, { 'x-forwarded-for': `${spoofed}, 198.51.100.7` }),
        peerEnv('10.0.0.1'),
      );
    expect((await send('192.0.2.1')).status).toBe(200);
    expect((await send('192.0.2.2')).status).toBe(429);
  });

  it('a missing or malformed entry shares one bucket', async () => {
    const { store, asked } = countingStore(1);
    const { app } = pipeline({ routes: [route], proxy: PROXY, store });
    const statuses: number[] = [];
    for (const value of ['junk', 'more junk', '999.1.1.1', '']) {
      const response = await app.request(path, post(path, { 'x-forwarded-for': value }));
      statuses.push(response.status);
    }
    statuses.push((await app.request(path, post(path))).status);
    expect(statuses).toEqual([200, 429, 429, 429, 429]);
    expect(new Set(asked.map((bucket) => bucket.key)).size).toBe(1);
  });

  it('with no socket and no trust, a request falls in the shared bucket', async () => {
    const { store } = countingStore(1);
    const { app } = pipeline({ routes: [route], store });
    expect((await app.request(path, post(path))).status).toBe(200);
    expect((await app.request(path, post(path))).status).toBe(429);
  });

  it('refuses with 429 and Retry-After, before the handler runs or the body is read', async () => {
    let handled = 0;
    const { store } = countingStore(0);
    const { app } = pipeline({
      routes: [
        publicRoute('invite_exchange', () => {
          handled += 1;
        }),
      ],
      store,
    });
    const sent = watchedBody();
    const response = await app.request(path, sent.init, peerEnv('203.0.113.9'));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(response.headers.get('ratelimit-limit')).toBe(
      String(ADDRESS_LIMIT_DEFAULTS.invite_exchange.capacity),
    );
    expect(Problem.parse(await response.json()).code).toBe('RATE_LIMITED');
    expect(handled).toBe(0);
    expect(sent.reads()).toBe(0);
  });

  it('reads the body once it is allowed, so the watched body proves something', async () => {
    const { store } = countingStore();
    const { app } = pipeline({ routes: [route], store });
    const sent = watchedBody();
    const response = await app.request(path, sent.init, peerEnv('203.0.113.9'));
    expect(response.status).toBe(200);
    expect(sent.reads()).toBeGreaterThan(0);
  });

  it('refuses a webhook the same way, before its bytes are read', async () => {
    let handled = 0;
    const webhook = defineWebhookRoute({
      id: 'limitedHook',
      path: '/v1/limited/hook',
      summary: 'A limited webhook',
      reason: 'Only here so a test can limit it.',
      headers: ['x-signature'],
      addressLimit: 'webhook',
      response: { name: 'Ok', schema: Ok },
      handler: () => {
        handled += 1;
        return Promise.resolve({ ok: true as const });
      },
    });
    const { store } = countingStore(0);
    const { app } = pipeline({ routes: [webhook], store });
    const sent = watchedBody();
    const response = await app.request('/v1/limited/hook', sent.init, peerEnv('203.0.113.9'));
    expect(response.status).toBe(429);
    expect(handled).toBe(0);
    expect(sent.reads()).toBe(0);
  });

  it('sends the limit headers on a success', async () => {
    const { store } = countingStore();
    const { app } = pipeline({ routes: [route], store });
    const response = await app.request(path, post(path), peerEnv('203.0.113.9'));
    expect(response.status).toBe(200);
    const rule = ADDRESS_LIMIT_DEFAULTS.invite_exchange;
    expect(response.headers.get('ratelimit-limit')).toBe(String(rule.capacity));
    expect(response.headers.get('ratelimit-remaining')).toBe(String(rule.capacity - 1));
  });

  it('gives each group its own bucket, so a flood on one cannot starve another', async () => {
    const receipts = publicRoute('receipt_verification');
    const { store } = countingStore(1);
    const { app } = pipeline({ routes: [route, receipts], store });
    const env = peerEnv('203.0.113.9');
    expect((await app.request(path, post(path), env)).status).toBe(200);
    expect((await app.request(path, post(path), env)).status).toBe(429);
    const other = '/v1/limited/receipt_verification';
    expect((await app.request(other, post(other), env)).status).toBe(200);
  });

  it('answers 503 when the store is down, rather than letting the request through', async () => {
    let handled = 0;
    const down: BucketStore = {
      take: () => Promise.reject(new DatabaseUnavailableError('ECONNREFUSED')),
    };
    const { app } = pipeline({
      routes: [
        publicRoute('invite_exchange', () => {
          handled += 1;
        }),
      ],
      store: down,
    });
    const response = await app.request(path, post(path), peerEnv('203.0.113.9'));
    expect(response.status).toBe(503);
    expect(Problem.parse(await response.json()).code).toBe('DB_UNAVAILABLE');
    expect(handled).toBe(0);
  });

  it('leaves no address in the bucket key, a log line, or the response', async () => {
    const { store, asked } = countingStore(1);
    const { app, logger } = pipeline({ routes: [route], proxy: PROXY, store });
    const address = '198.51.100.77';
    const answers: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const response = await app.request(
        path,
        post(path, { 'x-forwarded-for': `192.0.2.55, ${address}` }),
        peerEnv('10.9.8.7'),
      );
      answers.push(await response.text(), JSON.stringify([...response.headers.entries()]));
    }
    const everything = [JSON.stringify(asked), JSON.stringify(logger.records), ...answers].join(
      '\n',
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(logger.records.length).toBeGreaterThan(0);
    for (const secret of [address, '192.0.2.55', '10.9.8.7']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('will not build a server whose routes limit by address and that has no limit to use', () => {
    expect(() =>
      createApp({
        routes: [route],
        authenticate: refuseAllCredentials,
        rateLimit: allowEveryRequest,
        logger: memoryLogger(),
      }),
    ).toThrow(RouteRegistryError);
  });

  it('documents the 429 and its headers on a limited route only', () => {
    const paths = withOpenApiRoute([route]).document['paths'] as Record<
      string,
      Record<string, { responses: Record<string, { headers: Record<string, unknown> }> }>
    >;
    const limited = paths[path]?.['post']?.responses['429']?.headers ?? {};
    expect(Object.keys(limited)).toEqual(
      expect.arrayContaining(['Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining']),
    );
    expect(paths['/v1/openapi.json']?.['get']?.responses['429']).toBeUndefined();
  });

  it('reads the peer from a real socket', async () => {
    const { store, asked } = countingStore();
    const { app } = pipeline({ routes: [route], store });
    const server = await startServer(app, {
      port: 0,
      hostname: '127.0.0.1',
      requestTimeoutMs: 2000,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
        ...post(path, { 'x-forwarded-for': '198.51.100.1' }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
    expect(asked.map((bucket) => bucket.key)).toEqual([
      addressBucketKey('invite_exchange', '127.0.0.1', HMAC_KEY),
    ]);
  });
});

// Health has to answer however busy things are, or a load balancer drains a healthy
// instance, and the document is served from memory. Add to this list only with a
// reason as good: everything else on it would be free to hammer.
const PUBLIC_ROUTES_WITH_NO_LIMIT: ReadonlySet<string> = new Set(['getHealth', 'getOpenApi']);

function publicRoutesThatMustChoose(routes: readonly Route[]): string[] {
  return routes
    .filter(
      (route) =>
        route.access.kind === 'public' &&
        route.access.addressLimit === undefined &&
        !PUBLIC_ROUTES_WITH_NO_LIMIT.has(route.id),
    )
    .map((route) => route.id);
}

describe('which public routes have a limit', () => {
  const served = withOpenApiRoute(V1_ROUTES).routes;

  it('every public route has one, or is on the list of those allowed none', () => {
    expect(publicRoutesThatMustChoose(served)).toEqual([]);
  });

  it('this check fails a new public route that has not chosen', () => {
    const fresh = definePublicRoute({
      id: 'freshRoute',
      method: 'GET',
      path: '/v1/fresh',
      summary: 'New',
      reason: 'Only here so a test can see the check fail.',
      response: { name: 'Ok', schema: Ok },
      handler: () => Promise.resolve({ ok: true as const }),
    });
    expect(publicRoutesThatMustChoose([...served, fresh])).toEqual(['freshRoute']);
  });

  it('the list names only routes that exist, so it cannot hide a later one by name', () => {
    const ids = new Set(served.map((route) => route.id));
    for (const id of PUBLIC_ROUTES_WITH_NO_LIMIT) expect(ids.has(id), id).toBe(true);
  });

  it('receipt verification, the Self webhook and the invite exchange each have their own group', () => {
    const groupOf = (id: string) => {
      const access = served.find((route) => route.id === id)?.access;
      return access?.kind === 'public' ? access.addressLimit : undefined;
    };
    expect(groupOf('verifyReceipt')).toBe('receipt_verification');
    expect(groupOf('receiveSelfWebhook')).toBe('webhook');
    expect(groupOf('exchangeEmbedInvite')).toBe('invite_exchange');
  });
});

describe('the limit against a real database', () => {
  const adminUrl = inject('dbAdminUrl');
  const roleUrls = inject('dbRoleUrls');

  let database: TestDatabase;
  // Two pools, as two instances of the API would have.
  let first: Database;
  let second: Database;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl, import.meta.url);
    first = databaseAsServiceRoles(roleUrls, database);
    second = databaseAsServiceRoles(roleUrls, database);
  });

  afterAll(async () => {
    await first.close();
    await second.close();
    await database.drop();
  });

  const route = publicRoute('invite_exchange');
  const path = '/v1/limited/invite_exchange';

  function instance(db: Database, rule: RateLimitRule) {
    return createApp({
      routes: [route],
      authenticate: refuseAllCredentials,
      rateLimit: allowEveryRequest,
      addressRateLimit: createAddressRateLimit(databaseBucketStore(db), HMAC_KEY, {
        ...ADDRESS_LIMIT_DEFAULTS,
        invite_exchange: rule,
      }),
      logger: memoryLogger(),
    });
  }

  it('two API instances share one bucket per address, and keep a separate one for another', async () => {
    const rule = { capacity: 2, refillPerSecond: 1 };
    const one = instance(first, rule);
    const two = instance(second, rule);
    const send = (app: typeof one, peer: string) => app.request(path, post(path), peerEnv(peer));
    const started = Date.now();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await send(i % 2 === 0 ? one : two, '203.0.113.10')).status);
    }
    const seconds = Math.ceil((Date.now() - started) / 1000);
    const allowed = statuses.filter((status) => status === 200).length;
    // The bucket refills while the laptop is busy, so the bound allows for that.
    expect(allowed).toBeGreaterThanOrEqual(2);
    expect(allowed).toBeLessThanOrEqual(2 + seconds);
    expect(statuses.filter((status) => status === 429).length).toBe(8 - allowed);
    expect((await send(one, '203.0.113.11')).status).toBe(200);
  });
});
