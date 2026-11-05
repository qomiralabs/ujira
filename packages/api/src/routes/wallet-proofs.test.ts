// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The wallet proof routes over HTTP, through the whole pipeline, with the real
// identity flow on its in-memory ports and a fake chain.

import { randomUUID } from 'node:crypto';

import { Problem, WalletChallenge, WalletProofAccepted } from '@ujira/api-schema';
import type { WalletProofFlow } from '@ujira/identity';
import { TEST_NOW, newScope, walletProofWorld } from '@ujira/identity/testing';
import type { WalletProofWorld } from '@ujira/identity/testing';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import type { Authenticate } from '../auth.js';
import { refuseAllCredentials } from '../auth.js';
import { memoryLogger } from '../log.js';
import { allowEveryAddress, allowEveryRequest } from '../rate-limit.js';

import { V1_ROUTES, v1Routes } from './index.js';
import { SELF_WEBHOOK_NOT_CONFIGURED } from './self-webhook.js';

const TOKEN_ID = randomUUID();

// Keys by what they prove: the world's tenant with the scope or without it,
// and a key of another tenant.
function authFor(w: WalletProofWorld): Authenticate {
  const other = newScope();
  return (credentials) => {
    const token = credentials.authorization?.replace(/^Bearer /, '');
    if (token === 'writer') {
      return Promise.resolve({
        ok: true,
        tenant: { ...w.scope, tokenId: TOKEN_ID, scopes: ['recipients:write'] },
      });
    }
    if (token === 'reader') {
      return Promise.resolve({
        ok: true,
        tenant: { ...w.scope, tokenId: TOKEN_ID, scopes: ['recipients:read'] },
      });
    }
    if (token === 'intruder') {
      return Promise.resolve({
        ok: true,
        tenant: { ...other, tokenId: TOKEN_ID, scopes: ['recipients:write'] },
      });
    }
    return Promise.resolve({ ok: false, code: 'TOKEN_MALFORMED' });
  };
}

function served(w: WalletProofWorld, flow: WalletProofFlow = w.flow) {
  const logger = memoryLogger();
  const app = createApp({
    routes: v1Routes({ selfWebhook: SELF_WEBHOOK_NOT_CONFIGURED, walletProof: flow }),
    authenticate: authFor(w),
    rateLimit: allowEveryRequest,
    addressRateLimit: allowEveryAddress,
    logger,
  });
  const base = `/v1/recipients/${w.recipient.id}/methods/${w.method.id}`;
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });
  return {
    records: logger.records,
    challenge: (token = 'writer', path = `${base}/wallet-challenges`) =>
      app.request(path, { method: 'POST', headers: headers(token) }),
    prove: (body: unknown, token = 'writer', path = `${base}/wallet-proofs`) =>
      app.request(path, { method: 'POST', headers: headers(token), body: JSON.stringify(body) }),
  };
}

async function problemOf(response: Response): Promise<Problem> {
  const body = Problem.parse(await response.json());
  expect(body.status).toBe(response.status);
  return body;
}

// What the wallet sends back: the issued fields, with the world's signature.
async function issuedProof(w: WalletProofWorld, api: ReturnType<typeof served>) {
  const response = await api.challenge();
  expect(response.status).toBe(201);
  const issued = WalletChallenge.parse(await response.json());
  const signed = w.proofOf({
    challengeId: issued.challengeId as never,
    message: issued.message,
    nonce: issued.nonce,
    expiresAt: TEST_NOW,
  });
  return {
    issued,
    proof: {
      challengeId: signed.challengeId,
      message: signed.message,
      nonce: signed.nonce,
      signature: signed.signature,
    },
  };
}

describe('wallet challenges', () => {
  it('issues a challenge for the method', async () => {
    const w = walletProofWorld();
    const { issued } = await issuedProof(w, served(w));
    expect(issued.message).toContain(w.method.destination.address.value);
    expect(new Date(issued.expiresAt).getTime()).toBe(Number(TEST_NOW + 600n) * 1_000);
  });

  it('a missing method and another tenant are both not found', async () => {
    const w = walletProofWorld();
    const api = served(w);
    const missing = `/v1/recipients/${w.recipient.id}/methods/${w.recipient.id}/wallet-challenges`;
    expect((await problemOf(await api.challenge('writer', missing))).code).toBe('NOT_FOUND');
    expect((await problemOf(await api.challenge('intruder'))).code).toBe('NOT_FOUND');
    expect(w.proofs.rows(w.scope)).toEqual([]);
  });

  it('needs the recipients:write scope and a key', async () => {
    const w = walletProofWorld();
    const api = served(w);
    expect((await problemOf(await api.challenge('reader'))).code).toBe('INSUFFICIENT_SCOPE');
    expect((await problemOf(await api.challenge('none'))).code).toBe('TOKEN_MALFORMED');
  });
});

describe('wallet proofs', () => {
  it('records a proof, and refuses the same challenge the second time', async () => {
    const w = walletProofWorld();
    const api = served(w);
    const { proof } = await issuedProof(w, api);

    const first = await api.prove(proof);
    expect(first.status).toBe(201);
    expect(WalletProofAccepted.parse(await first.json())).toMatchObject({
      level: 'wallet_signature',
      signerKey: w.method.destination.address.value,
    });
    expect((await w.store.latestVerification(w.scope, w.method.id))?.level).toBe(
      'wallet_signature',
    );

    const second = await api.prove(proof);
    expect(second.status).toBe(422);
    expect(await problemOf(second)).toMatchObject({
      code: 'WALLET_PROOF_INVALID',
      detail: 'ALREADY_USED',
    });
  });

  it('after 600 seconds gives WALLET_PROOF_EXPIRED', async () => {
    const w = walletProofWorld();
    const api = served(w);
    const { proof } = await issuedProof(w, api);
    w.clock.set((TEST_NOW + 600n) as typeof TEST_NOW);
    const response = await api.prove(proof);
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('WALLET_PROOF_EXPIRED');
  });

  it('NO_TRUSTLINE returns 422 DESTINATION_NOT_RECEIVABLE and writes no verification row', async () => {
    const w = walletProofWorld();
    const api = served(w);
    const { proof } = await issuedProof(w, api);
    w.chain.destination = { receivable: false, reason: 'NO_TRUSTLINE', proofSigner: 'current' };
    const response = await api.prove(proof);
    expect(response.status).toBe(422);
    expect(await problemOf(response)).toMatchObject({
      code: 'DESTINATION_NOT_RECEIVABLE',
      detail: 'NO_TRUSTLINE',
    });
    expect(await w.store.latestVerification(w.scope, w.method.id)).toBeNull();
  });

  it('a removed signer returns 422 WALLET_SIGNER_NOT_AUTHORIZED', async () => {
    const w = walletProofWorld();
    const api = served(w);
    const { proof } = await issuedProof(w, api);
    w.chain.verdict = 'SIGNER_NOT_AUTHORIZED';
    const response = await api.prove(proof);
    expect(response.status).toBe(422);
    const body = await problemOf(response);
    expect(body.code).toBe('WALLET_SIGNER_NOT_AUTHORIZED');
    expect(body.detail).toBeUndefined();
  });

  it('a chain outage is 503 with Retry-After, and the challenge stays open', async () => {
    const w = walletProofWorld();
    const api = served(w);
    const { proof } = await issuedProof(w, api);
    w.chain.checkFailure = 'hang';
    const response = await api.prove(proof);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect((await problemOf(response)).code).toBe('CHAIN_UNAVAILABLE');
    w.chain.checkFailure = null;
    expect((await api.prove(proof)).status).toBe(201);
  });

  it("another tenant cannot use this tenant's challenge, nor send it to another method", async () => {
    const w = walletProofWorld();
    const api = served(w);
    const { proof } = await issuedProof(w, api);
    const intruder = await api.prove(proof, 'intruder');
    expect((await problemOf(intruder)).code).toBe('WALLET_PROOF_INVALID');

    const elsewhere = `/v1/recipients/${w.recipient.id}/methods/${w.recipient.id}/wallet-proofs`;
    expect((await problemOf(await api.prove(proof, 'writer', elsewhere))).code).toBe(
      'WALLET_PROOF_INVALID',
    );
    expect(await w.store.latestVerification(w.scope, w.method.id)).toBeNull();
  });

  it('a malformed body and a malformed id are refused before the flow runs', async () => {
    const w = walletProofWorld();
    const api = served(w);
    const body = await problemOf(await api.prove({ challengeId: 'x' }));
    expect(body.code).toBe('INVALID_REQUEST');
    const badId = '/v1/recipients/not-a-uuid/methods/also-not/wallet-proofs';
    expect((await problemOf(await api.prove({}, 'writer', badId))).code).toBe('NOT_FOUND');
    expect(w.chain.verifications).toEqual([]);
  });

  it('logs nothing of the proof', async () => {
    const w = walletProofWorld();
    const api = served(w);
    const { proof } = await issuedProof(w, api);
    await api.prove(proof);
    const logged = JSON.stringify(api.records);
    for (const secret of [proof.signature, proof.nonce, proof.message]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('an unexpected flow error is a 500 logged by class name', async () => {
    const w = walletProofWorld();
    const failing: WalletProofFlow = {
      createWalletChallenge: () => Promise.reject(new Error('alice@example.com')),
      submitWalletProof: () => Promise.reject(new Error('alice@example.com')),
    };
    const api = served(w, failing);
    const response = await api.challenge();
    expect(response.status).toBe(500);
    const proofResponse = await api.prove({
      challengeId: w.recipient.id,
      message: 'm',
      nonce: 'n',
      signature: 's',
    });
    expect(proofResponse.status).toBe(500);
    expect(JSON.stringify(api.records)).not.toContain('alice');
  });
});

describe('the served route table', () => {
  it('answers 503 until the flow is configured', async () => {
    const w = walletProofWorld();
    const app = createApp({
      routes: V1_ROUTES,
      authenticate: authFor(w),
      rateLimit: allowEveryRequest,
      addressRateLimit: allowEveryAddress,
      logger: memoryLogger(),
    });
    const base = `/v1/recipients/${w.recipient.id}/methods/${w.method.id}`;
    const headers = { authorization: 'Bearer writer', 'content-type': 'application/json' };
    const challenge = await app.request(`${base}/wallet-challenges`, { method: 'POST', headers });
    expect(challenge.status).toBe(503);
    const proof = await app.request(`${base}/wallet-proofs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        challengeId: w.recipient.id,
        message: 'm',
        nonce: 'n',
        signature: 's',
      }),
    });
    expect((await problemOf(proof)).code).toBe('CHAIN_UNAVAILABLE');
  });

  it('every key is refused while the served API has no authentication', async () => {
    const w = walletProofWorld();
    const app = createApp({
      routes: V1_ROUTES,
      authenticate: refuseAllCredentials,
      rateLimit: allowEveryRequest,
      addressRateLimit: allowEveryAddress,
      logger: memoryLogger(),
    });
    const response = await app.request(
      `/v1/recipients/${w.recipient.id}/methods/${w.method.id}/wallet-challenges`,
      { method: 'POST', headers: { authorization: 'Bearer writer' } },
    );
    expect(response.status).toBe(401);
  });
});
