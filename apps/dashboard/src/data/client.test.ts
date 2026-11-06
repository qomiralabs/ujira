// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiProblem, createDataClient, DataError } from './client';

const Thing = z.strictObject({ id: z.string(), count: z.number().int() });

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function urlOf(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function problem(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return respond(
    status,
    {
      type: `https://docs.ujira.co/errors/${code}`,
      title: 'Something',
      status,
      code,
      requestId: 'req_0123456789',
      ...extra,
    },
    { 'Content-Type': 'application/problem+json', 'Request-Id': 'req_0123456789' },
  );
}

describe('createDataClient', () => {
  it('sends the session cookie, the project and a JSON body, and parses the answer', async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(respond(201, { id: 'a', count: 2 })));
    const client = createDataClient({ baseUrl: 'https://api.example.test', fetch: send });
    const result = await client.request({
      method: 'POST',
      path: '/v1/things',
      project: 'bounties',
      body: { name: 'x' },
      schema: Thing,
    });
    expect(result).toEqual({ id: 'a', count: 2 });
    const [input, init] = send.mock.calls[0] ?? [];
    expect(urlOf(input)).toBe('https://api.example.test/v1/things');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.cache).toBe('no-store');
    const headers = new Headers(init?.headers);
    expect(headers.get('Ujira-Project')).toBe('bounties');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{"name":"x"}');
  });

  it('adds only the query values that are set', async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(respond(200, { id: 'a', count: 1 })));
    const client = createDataClient({ baseUrl: 'https://api.example.test', fetch: send });
    await client.request({
      method: 'GET',
      path: '/v1/things',
      project: 'labelling',
      query: { cursor: 'abc', limit: undefined },
      schema: Thing,
    });
    expect(urlOf(send.mock.calls[0]?.[0])).toBe('https://api.example.test/v1/things?cursor=abc');
    expect(send.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('defaults to the page origin', async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(respond(200, { id: 'a', count: 1 })));
    const client = createDataClient({ fetch: send });
    await client.request({ method: 'GET', path: '/v1/things', project: 'p', schema: Thing });
    expect(urlOf(send.mock.calls[0]?.[0])).toBe(`${window.location.origin}/v1/things`);
  });

  it('refuses a success body that does not match its schema, without echoing it', async () => {
    const client = createDataClient({
      fetch: () => Promise.resolve(respond(200, { id: 'a', count: 'ujk_secret_text' })),
    });
    const error = await client
      .request({ method: 'GET', path: '/v1/things', project: 'p', schema: Thing })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).kind).toBe('invalid_response');
    expect(JSON.stringify(error)).not.toContain('ujk_secret_text');
    expect((error as Error).message).not.toContain('ujk_secret_text');
  });

  it('turns a problem body into an ApiProblem with its code and reference', async () => {
    const client = createDataClient({
      fetch: () =>
        Promise.resolve(
          problem('API_KEY_EXPIRY_INVALID', 422, {
            errors: [{ field: 'expiresInDays', code: 'invalid_value' }],
          }),
        ),
    });
    const error = await client
      .request({ method: 'POST', path: '/v1/things', project: 'p', body: {}, schema: Thing })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblem);
    const p = error as ApiProblem;
    expect(p.code).toBe('API_KEY_EXPIRY_INVALID');
    expect(p.status).toBe(422);
    expect(p.requestId).toBe('req_0123456789');
    expect(p.fieldErrors).toEqual([{ field: 'expiresInDays', code: 'invalid_value' }]);
  });

  it('knows codes it has never seen, since the API adds codes over time', async () => {
    const client = createDataClient({
      fetch: () => Promise.resolve(problem('SOMETHING_NEW', 409)),
    });
    const error = await client
      .request({ method: 'GET', path: '/v1/things', project: 'p', schema: Thing })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblem);
    expect((error as ApiProblem).code).toBe('SOMETHING_NEW');
  });

  it('reports an error status with no problem body as an invalid response, keeping the reference', async () => {
    const client = createDataClient({
      fetch: () =>
        Promise.resolve(
          respond(502, '<html>bad gateway</html>', { 'Request-Id': 'req_gateway01' }),
        ),
    });
    const error = await client
      .request({ method: 'GET', path: '/v1/things', project: 'p', schema: Thing })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).kind).toBe('invalid_response');
    expect((error as DataError).status).toBe(502);
    expect((error as DataError).requestId).toBe('req_gateway01');
  });

  it('reports a failed connection as a network error', async () => {
    const client = createDataClient({ fetch: () => Promise.reject(new TypeError('offline')) });
    const error = await client
      .request({ method: 'GET', path: '/v1/things', project: 'p', schema: Thing })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).kind).toBe('network');
  });

  it('lets an abort through as an abort', async () => {
    const controller = new AbortController();
    const client = createDataClient({
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const pending = client.request({
      method: 'GET',
      path: '/v1/things',
      project: 'p',
      schema: Thing,
      signal: controller.signal,
    });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).kind).toBe('aborted');
  });

  it('accepts an empty answer where the schema allows nothing', async () => {
    const client = createDataClient({
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    await expect(
      client.request({
        method: 'POST',
        path: '/v1/session/step-up',
        project: 'p',
        body: { code: '123456' },
        schema: z.undefined(),
      }),
    ).resolves.toBeUndefined();
  });
});
