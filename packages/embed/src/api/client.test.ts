// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { ApiProblem, ApiUnreachable, httpClient } from './client.js';

interface Sent {
  url: string;
  init: RequestInit;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** The JSON a request carried. */
function bodyOf(sent: Sent | undefined): unknown {
  const body = sent?.init.body;
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

function answering(status: number, body: unknown): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: (input, init) => {
      sent.push({ url: urlOf(input), init: init ?? {} });
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

const SESSION = {
  recipientId: 'r-1',
  country: 'KE',
  network: 'stellar:testnet',
  methods: ['stellar_wallet'],
  neverPayable: [],
  activation: { offered: false },
  verification: [],
};

describe('the HTTP client', () => {
  it('reads a session that lists no identity checks as needing none', async () => {
    const { verification, ...without } = SESSION;
    expect(verification).toEqual([]);
    const api = answering(200, without);
    const client = httpClient({ baseUrl: 'https://api.example', token: 't', fetch: api.fetch });
    expect((await client.session()).verification).toEqual([]);
  });

  it('starts, reports and reads a check at its paths, sending only what it must', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const client = httpClient({
      baseUrl: 'https://api.example',
      token: 't',
      fetch: (input, init) => {
        const url = urlOf(input);
        sent.push({ url, body: bodyOf({ url, init: init ?? {} }) });
        const json = url.endsWith('/verifications')
          ? {
              verificationId: 'c-1',
              provider: 'self',
              url: 'https://self.example/c-1',
              expiresAt: 'x',
            }
          : { verificationId: 'c-1', status: 'pending' };
        return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
      },
    });
    await client.startVerification('r', 'stellar_wallet');
    // A caller that adds to the report cannot get the extra field sent.
    const report = { status: 'completed', reference: 'c-1', name: 'Amara Eze' } as const;
    await client.reportVerification('r', 'c-1', report);
    await client.verificationState('r', 'c-1');
    expect(sent).toEqual([
      {
        url: 'https://api.example/v1/embed/recipients/r/verifications',
        body: { method: 'stellar_wallet' },
      },
      {
        url: 'https://api.example/v1/embed/recipients/r/verifications/c-1/reports',
        body: { status: 'completed', reference: 'c-1' },
      },
      { url: 'https://api.example/v1/embed/recipients/r/verifications/c-1', body: undefined },
    ]);
  });

  it('refuses a provider page that is not https', async () => {
    const client = httpClient({
      baseUrl: 'https://api.example',
      token: 't',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              verificationId: 'c-1',
              provider: 'self',
              url: 'javascript:alert(1)',
              expiresAt: 'x',
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(client.startVerification('r', 'stellar_wallet')).rejects.toBeInstanceOf(
      ApiUnreachable,
    );
  });

  it('sends the embed token and no cookies', async () => {
    const api = answering(200, SESSION);
    const client = httpClient({
      baseUrl: 'https://api.example/',
      token: 'ujes_test_x',
      fetch: api.fetch,
    });
    await expect(client.session()).resolves.toEqual(SESSION);
    const [first] = api.sent;
    expect(first?.url).toBe('https://api.example/v1/embed/onboarding');
    expect(first?.init.method).toBe('GET');
    expect(first?.init.credentials).toBe('omit');
    expect(new Headers(first?.init.headers).get('authorization')).toBe('Bearer ujes_test_x');
  });

  it('drops a field the API adds later rather than refusing the answer', async () => {
    const api = answering(200, { ...SESSION, somethingNew: true });
    const client = httpClient({ baseUrl: 'https://api.example', token: 't', fetch: api.fetch });
    expect(await client.session()).toEqual(SESSION);
  });

  it('refuses an answer outside the contract', async () => {
    const api = answering(200, { ...SESSION, country: 'Kenya' });
    const client = httpClient({ baseUrl: 'https://api.example', token: 't', fetch: api.fetch });
    await expect(client.session()).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('turns a problem body into an ApiProblem', async () => {
    const api = answering(422, {
      status: 422,
      code: 'DESTINATION_INVALID',
      detail: 'no',
      requestId: 'req_12345678',
    });
    const client = httpClient({ baseUrl: 'https://api.example', token: 't', fetch: api.fetch });
    const error: unknown = await client
      .addMethod('r-1', {
        method: 'stellar_wallet',
        destination: { network: 'stellar:testnet', address: 'GABC', memo: '12' },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiProblem);
    expect((error as ApiProblem).problem.code).toBe('DESTINATION_INVALID');
    expect(api.sent[0]?.url).toBe('https://api.example/v1/embed/recipients/r-1/methods');
    expect(bodyOf(api.sent[0])).toEqual({
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: 'GABC', memoType: 'id', memo: '12' },
    });
  });

  it('sends no memo type when there is no memo', async () => {
    const api = answering(201, { id: 'm-1', method: 'stellar_wallet', status: 'active' });
    const client = httpClient({ baseUrl: 'https://api.example', token: 't', fetch: api.fetch });
    await client.addMethod('r-1', {
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: 'GABC' },
    });
    expect(bodyOf(api.sent[0])).toEqual({
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: 'GABC' },
    });
  });

  it('escapes ids in paths', async () => {
    const api = answering(201, {
      challengeId: 'c',
      message: 'm',
      nonce: 'n',
      expiresAt: '2026-11-05T12:00:00Z',
    });
    const client = httpClient({ baseUrl: 'https://api.example', token: 't', fetch: api.fetch });
    await client.createWalletChallenge('r/1', 'm?2');
    expect(api.sent[0]?.url).toBe(
      'https://api.example/v1/embed/recipients/r%2F1/methods/m%3F2/wallet-challenges',
    );
  });

  it('reports a failure without a problem body, and a request that never left', async () => {
    const empty = answering(502, undefined);
    const client = httpClient({ baseUrl: 'https://api.example', token: 't', fetch: empty.fetch });
    await expect(client.session()).rejects.toBeInstanceOf(ApiUnreachable);
    const offline = httpClient({
      baseUrl: 'https://api.example',
      token: 't',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(offline.session()).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('reaches every route of the contract at its path', async () => {
    const answers: Record<string, unknown> = {
      'wallet-proofs': { verificationId: 'v', level: 'wallet_signature' },
      activations: {
        activationId: 'a-1',
        transaction: 'AAAA',
        networkPassphrase: 'Test SDF Network ; September 2015',
        expiresAt: '2026-11-05T12:00:00Z',
      },
      submissions: { status: 'landed' },
    };
    const sent: string[] = [];
    const client = httpClient({
      baseUrl: 'https://api.example',
      token: 't',
      fetch: (input) => {
        const url = urlOf(input);
        sent.push(url);
        const last = url.split('/').pop() ?? '';
        return Promise.resolve(new Response(JSON.stringify(answers[last]), { status: 201 }));
      },
    });
    await client.submitWalletProof('r', 'm', {
      challengeId: 'c',
      message: 'm',
      nonce: 'n',
      signature: 's',
    });
    await client.requestActivation('r', 'm');
    await client.submitActivation('a-1', 'signed');
    expect(sent).toEqual([
      'https://api.example/v1/embed/recipients/r/methods/m/wallet-proofs',
      'https://api.example/v1/embed/recipients/r/methods/m/activations',
      'https://api.example/v1/embed/activations/a-1/submissions',
    ]);
  });
});
