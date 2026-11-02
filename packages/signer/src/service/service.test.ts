// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the signer service and its client (service/service.ts,
 * service/auth.ts, remote.ts).
 *
 * The service answers POST /v1/sign, GET /v1/address and GET /v1/health to
 * callers holding a configured token, with a code and never a reason: 401
 * for an unknown token, 403 SIGNER_DENIED for a refusal or an unreadable
 * request, 404 for any other path, 413 above the body limit, 503 when the
 * backend is unavailable and 500 for anything else. RemoteSigner maps those
 * back to the port errors, treats a dropped call, a timeout or an
 * unreadable response as SIGNER_UNAVAILABLE, and refuses a signature it
 * cannot verify over the bytes it computes itself.
 */

import {
  InvalidInputError,
  SignerAddressMismatchError,
  SignerDeniedError,
  SignerUnavailableError,
} from '@ujira/chain-adapter';
import type { SignPayload, SignerProvider, SignerRef } from '@ujira/chain-adapter';
import { testTransactionXdr } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { RemoteSigner } from '../remote.js';
import { CALLER_TOKEN, OPTS, codeOf, harness } from '../testing/service.js';
import { toWire } from '../wire.js';
import { backendOnlyPolicy, tokenAuthenticator } from './index.js';

const NETWORK = 'stellar:testnet';
const EXECUTOR: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };
const BASE = 'http://signer.internal:10000';

async function payloadFor(service = harness({ policy: backendOnlyPolicy() })) {
  const source = (await service.backend.address(EXECUTOR, OPTS)).value;
  const payload: SignPayload = {
    kind: 'stellar_tx',
    network: NETWORK,
    xdr: testTransactionXdr({ source }),
  };
  return { service, payload };
}

function raw(service: ReturnType<typeof harness>, path: string, init: RequestInit = {}) {
  return service.fetch(new URL(path, BASE), {
    ...init,
    headers: { authorization: `Bearer ${CALLER_TOKEN}` },
  });
}

function failing(error: unknown): SignerProvider {
  const fail = () => Promise.reject(error instanceof Error ? error : new Error('backend'));
  return { sign: fail, address: fail, health: fail };
}

describe('the signer service', () => {
  it('signs, answers addresses and reports health for a known caller', async () => {
    const { service, payload } = await payloadFor();
    const result = await service.remote.sign(EXECUTOR, payload, OPTS);
    expect(result.kind).toBe('ed25519');
    expect(await service.remote.address(EXECUTOR, OPTS)).toEqual(
      await service.backend.address(EXECUTOR, OPTS),
    );
    const health = await service.remote.health(OPTS);
    expect(health.state).toBe('healthy');
    expect(typeof health.checkedAt).toBe('bigint');
  });

  it('refuses an unknown token on every route', async () => {
    const { service, payload } = await payloadFor();
    expect(await codeOf(service.stranger.sign(EXECUTOR, payload, OPTS))).toBe('SIGNER_DENIED');
    expect(await codeOf(service.stranger.address(EXECUTOR, OPTS))).toBe('SIGNER_DENIED');
    expect(await codeOf(service.stranger.health(OPTS))).toBe('SIGNER_DENIED');
    const response = await service.fetch(new URL('/v1/health', BASE));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":{"code":"UNAUTHENTICATED"}}');
  });

  it('answers 404, 413 and 403 with a code only', async () => {
    const { service } = await payloadFor();
    const missing = await raw(service, '/v1/keys');
    expect(missing.status).toBe(404);
    const large = await raw(service, '/v1/sign', { method: 'POST', body: 'x'.repeat(300_000) });
    expect(large.status).toBe(413);
    for (const body of ['not json', '{}', toWire({ ref: EXECUTOR, payload: { kind: 'raw' } })]) {
      const refused = await raw(service, '/v1/sign', { method: 'POST', body });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe('{"error":{"code":"SIGNER_DENIED"}}');
    }
    const badRef = await raw(service, '/v1/address?ref=%7B');
    expect(badRef.status).toBe(403);
  });

  it('passes backend failures back as port errors, never as text', async () => {
    const cases: [unknown, unknown][] = [
      [new SignerUnavailableError(), SignerUnavailableError],
      [new SignerAddressMismatchError(), SignerAddressMismatchError],
      [new SignerDeniedError(), SignerDeniedError],
      [new Error('a backend detail that must stay inside'), SignerUnavailableError],
    ];
    for (const [error, expected] of cases) {
      const { service, payload } = await payloadFor(
        harness({ policy: backendOnlyPolicy(), provider: failing(error) }),
      );
      await expect(service.remote.sign(EXECUTOR, payload, OPTS)).rejects.toBeInstanceOf(expected);
      await expect(service.remote.address(EXECUTOR, OPTS)).rejects.toBeInstanceOf(expected);
      await expect(service.remote.health(OPTS)).rejects.toBeInstanceOf(expected);
    }
    const leaky = harness({ policy: backendOnlyPolicy(), provider: failing(new Error('secret')) });
    const response = await raw(leaky, '/v1/health');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
  });

  it('turns a throw outside the handlers into a bare 500', async () => {
    const policy = { ...backendOnlyPolicy(), check: () => Promise.reject(new Error('policy bug')) };
    const { service, payload } = await payloadFor(harness({ policy }));
    expect(await codeOf(service.remote.sign(EXECUTOR, payload, OPTS))).toBe('SIGNER_UNAVAILABLE');
  });

  it('logs the tenant a policy names', async () => {
    const policy = {
      ...backendOnlyPolicy(),
      check: () =>
        Promise.resolve({
          tenant: { principalId: 'p', projectId: 'q' } as never,
        }),
    };
    const { service, payload } = await payloadFor(harness({ policy }));
    await service.remote.sign(EXECUTOR, payload, OPTS);
    expect(service.records.at(-1)).toMatchObject({
      event: 'sign_ok',
      principalId: 'p',
      projectId: 'q',
    });
  });
});

describe('the remote client', () => {
  const answer =
    (status: number, body: string): typeof fetch =>
    () =>
      Promise.resolve(new Response(body, { status }));
  const client = (fetchImpl: typeof fetch) =>
    new RemoteSigner({ baseUrl: BASE, token: CALLER_TOKEN, timeoutMs: 1_000, fetch: fetchImpl });

  it('tries once more when a connection drops a request, and only once', async () => {
    const { service, payload } = await payloadFor();
    let calls = 0;
    const flaky = client((input, init) => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new TypeError('fetch failed'))
        : service.fetch(input, init);
    });
    expect((await flaky.sign(EXECUTOR, payload, OPTS)).kind).toBe('ed25519');
    expect(calls).toBe(2);
    calls = 0;
    const down = client(() => {
      calls += 1;
      return Promise.reject(new TypeError('fetch failed'));
    });
    expect(await codeOf(down.health(OPTS))).toBe('SIGNER_UNAVAILABLE');
    expect(calls).toBe(2);
  });

  it('does not try again once the caller has given up', async () => {
    const controller = new AbortController();
    let calls = 0;
    const aborting = client(() => {
      calls += 1;
      controller.abort();
      return Promise.reject(new TypeError('aborted'));
    });
    expect(await codeOf(aborting.health({ ...OPTS, signal: controller.signal }))).toBe(
      'SIGNER_UNAVAILABLE',
    );
    expect(calls).toBe(1);
  });

  it('treats a dropped call, an abort and a timeout as unavailable', async () => {
    const { payload } = await payloadFor();
    const dropped = client(() => Promise.reject(new TypeError('fetch failed')));
    expect(await codeOf(dropped.sign(EXECUTOR, payload, OPTS))).toBe('SIGNER_UNAVAILABLE');
    const controller = new AbortController();
    controller.abort();
    const hanging = client(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted === true) reject(new Error('aborted'));
          signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    expect(await codeOf(hanging.health({ ...OPTS, signal: controller.signal }))).toBe(
      'SIGNER_UNAVAILABLE',
    );
    const slow = new RemoteSigner({
      baseUrl: BASE,
      token: CALLER_TOKEN,
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('timeout'));
          });
        }),
    });
    expect(await codeOf(slow.health(OPTS))).toBe('SIGNER_UNAVAILABLE');
  });

  it('refuses responses it cannot read', async () => {
    const { payload } = await payloadFor();
    expect(await codeOf(client(answer(200, 'not json')).sign(EXECUTOR, payload, OPTS))).toBe(
      'SIGNER_UNAVAILABLE',
    );
    expect(await codeOf(client(answer(200, '{}')).health(OPTS))).toBe('SIGNER_UNAVAILABLE');
    expect(await codeOf(client(answer(502, '<html>')).health(OPTS))).toBe('SIGNER_UNAVAILABLE');
    const huge = `{"pad":"${'x'.repeat(300_000)}"}`;
    expect(await codeOf(client(answer(200, huge)).health(OPTS))).toBe('SIGNER_UNAVAILABLE');
    const pubnet = toWire({ address: { network: 'stellar:pubnet', value: 'G' } });
    expect(await codeOf(client(answer(200, pubnet)).address(EXECUTOR, OPTS))).toBe(
      'SIGNER_UNAVAILABLE',
    );
    const notAccount = toWire({ address: { network: NETWORK, value: 'GABC' } });
    expect(await codeOf(client(answer(200, notAccount)).address(EXECUTOR, OPTS))).toBe(
      'SIGNER_UNAVAILABLE',
    );
  });

  it('refuses a signature it cannot verify over the payload', async () => {
    const { service, payload } = await payloadFor();
    const real = await service.backend.sign(EXECUTOR, payload, OPTS);
    const forged = { ...real, signature: new Uint8Array(64) };
    expect(
      await codeOf(
        client(answer(200, toWire({ signature: forged }))).sign(EXECUTOR, payload, OPTS),
      ),
    ).toBe('SIGNER_DENIED');
    // A real signature, but by a key that is not the payload's source.
    const other = await service.backend.sign(
      { ...EXECUTOR, keyId: 'executor_1' },
      {
        kind: 'stellar_tx',
        network: NETWORK,
        xdr: testTransactionXdr({
          source: (await service.backend.address({ ...EXECUTOR, keyId: 'executor_1' }, OPTS)).value,
        }),
      },
      OPTS,
    );
    expect(
      await codeOf(client(answer(200, toWire({ signature: other }))).sign(EXECUTOR, payload, OPTS)),
    ).toBe('SIGNER_DENIED');
  });
});

describe('caller tokens', () => {
  it('refuse a configuration that could not authenticate safely', () => {
    const token = 'k'.repeat(32);
    const cases: [Parameters<typeof tokenAuthenticator>[0], string][] = [
      [[], 'callers (empty)'],
      [[{ name: 'Payouts', token }], 'callers.0.name (invalid)'],
      [[{ name: 'payouts', token: 'short' }], 'callers.0.token (too_short)'],
      [
        [
          { name: 'payouts', token },
          { name: 'adapter', token },
        ],
        'callers (duplicate_token)',
      ],
    ];
    for (const [callers, issue] of cases) {
      expect(() => tokenAuthenticator(callers)).toThrow(InvalidInputError);
      try {
        tokenAuthenticator(callers);
      } catch (error) {
        expect((error as InvalidInputError).issues).toEqual([issue]);
      }
    }
  });

  it('names the caller of a known token and no one else', () => {
    const token = 'k'.repeat(32);
    const authenticate = tokenAuthenticator([{ name: 'payouts', token }]);
    expect(authenticate(`Bearer ${token}`)).toBe('payouts');
    expect(authenticate(`Bearer ${token}x`)).toBeNull();
    expect(authenticate(token)).toBeNull();
    expect(authenticate(null)).toBeNull();
    expect(authenticate('Bearer ')).toBeNull();
  });
});
