// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PayoutPage } from '@ujira/api-schema';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ApiProblemError,
  ApiResponseInvalidError,
  ApiTimeoutError,
  ApiUnreachableError,
  createApiClient,
} from './client.js';
import { API_KEY, API_URL, fakeApi } from './fake-api.test-support.js';

const servers: Server[] = [];

// A real server, for what a stub of fetch could not prove.
async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

function clientWith(fetchImpl: typeof fetch, apiKey = API_KEY) {
  return createApiClient({ apiUrl: API_URL, apiKey, fetch: fetchImpl });
}

const answering =
  (body: string, status = 200): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status }));

describe('reading a route', () => {
  it('sends the key as a bearer and returns what the contract describes', async () => {
    const api = fakeApi();
    const page = await clientWith(api.fetch).read('listPayouts', { query: { limit: '2' } });
    expect(PayoutPage.parse(page).items).toHaveLength(2);
    expect(api.requests[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(new URL(api.requests[0]?.url ?? '').pathname).toBe('/v1/payouts');
  });

  it('escapes a path parameter, so it cannot reach another route', async () => {
    const api = fakeApi();
    await expect(
      clientWith(api.fetch).read('getPayout', { params: { id: '../mandates' } }),
    ).rejects.toBeInstanceOf(ApiProblemError);
    expect(new URL(api.requests[0]?.url ?? '').pathname).toBe('/v1/payouts/..%2Fmandates');
  });

  it('turns a problem body into an error with its code and request id', async () => {
    const api = fakeApi();
    const failure = await clientWith(api.fetch, 'wrong')
      .read('listPayouts')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problem = failure as ApiProblemError;
    expect(problem.status).toBe(401);
    expect(problem.code).toMatch(/^TOKEN_/);
    expect(problem.message).toContain(problem.requestId);
  });
});

describe('what it refuses', () => {
  it('a response off the contract is an error', async () => {
    const off = answering(JSON.stringify({ items: [{ surprise: true }], nextCursor: null }));
    await expect(clientWith(off).read('listPayouts')).rejects.toBeInstanceOf(
      ApiResponseInvalidError,
    );
  });

  it.each([
    ['text where JSON belongs', '<html>bad gateway</html>', 502],
    ['an error body that is not a problem', JSON.stringify({ oops: true }), 500],
    ['a success that is not JSON', 'ok', 200],
  ])('%s is an error', async (_name, body, status) => {
    await expect(clientWith(answering(body, status)).read('listPayouts')).rejects.toBeInstanceOf(
      ApiResponseInvalidError,
    );
  });

  it('holds no key in any error', async () => {
    const failing: readonly (typeof fetch)[] = [
      answering('nope', 500),
      answering('{}'),
      () => Promise.reject(new TypeError('network down')),
      fakeApi().fetch,
    ];
    for (const fetchImpl of failing) {
      const failure = await clientWith(fetchImpl)
        .read('getPayout', { params: { id: 'nope' } })
        .catch((error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(Error);
      const { message, stack } = failure as Error;
      expect(`${message} ${stack ?? ''}`).not.toContain(API_KEY);
    }
  });
});

describe('talking to a real server', () => {
  it('follows no redirect, so the key cannot go with it', async () => {
    const seenElsewhere: (string | undefined)[] = [];
    const elsewhere = await listen((request, response) => {
      seenElsewhere.push(request.headers.authorization);
      response.end('{}');
    });
    const redirecting = await listen((_request, response) => {
      response.writeHead(302, { location: `${elsewhere}/v1/payouts` });
      response.end();
    });
    const client = createApiClient({ apiUrl: redirecting, apiKey: API_KEY });
    await expect(client.read('listPayouts')).rejects.toBeInstanceOf(ApiUnreachableError);
    expect(seenElsewhere).toEqual([]);
  });

  it('times out', async () => {
    const hanging = await listen(() => {
      // Never answers.
    });
    const client = createApiClient({ apiUrl: hanging, apiKey: API_KEY, timeoutMs: 50 });
    await expect(client.read('listPayouts')).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it('times out on a body that stops halfway', async () => {
    const stalling = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    });
    const client = createApiClient({ apiUrl: stalling, apiKey: API_KEY, timeoutMs: 50 });
    await expect(client.read('listPayouts')).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it('stops when the caller gives up, and says it was not the timeout', async () => {
    const hanging = await listen(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const client = createApiClient({ apiUrl: hanging, apiKey: API_KEY });
    const read = client.read('listPayouts', { signal: controller.signal });
    controller.abort();
    await expect(read).rejects.toBeInstanceOf(ApiUnreachableError);
  });

  it('a server that is not there is an error, not a hang', async () => {
    const gone = await listen(() => undefined);
    const server = servers.pop();
    server?.close();
    const client = createApiClient({ apiUrl: gone, apiKey: API_KEY });
    await expect(client.read('listPayouts')).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
