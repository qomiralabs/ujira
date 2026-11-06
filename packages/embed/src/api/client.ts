// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one way the widget talks to UJIRA. Everything goes through this
// interface, so the widget runs the same against the real API and against
// the fake the tests use.
//
// The HTTP client authenticates with the embed token the integrator's server
// minted for this one recipient. The token is meant for a browser: it reaches
// only that recipient, only from the pages the session allows, and only for
// half an hour.

import type * as z from 'zod/mini';

import {
  ActivationLanded,
  ActivationOffer,
  OnboardingSession,
  Problem,
  SavedMethod,
  WalletChallenge,
  WalletProofAccepted,
  type ApiMethod,
} from './contract.js';

export interface DestinationBody {
  network: string;
  address: string;
  /** A numeric memo, as text. Absent when there is none. */
  memo?: string;
}

export interface WalletProof {
  challengeId: string;
  message: string;
  nonce: string;
  signature: string;
  /** The key that signed, when it is not the account's own. */
  signer?: string;
}

export interface OnboardingClient {
  session(): Promise<OnboardingSession>;
  addMethod(
    recipientId: string,
    body: { method: ApiMethod; destination: DestinationBody },
  ): Promise<SavedMethod>;
  createWalletChallenge(recipientId: string, methodId: string): Promise<WalletChallenge>;
  submitWalletProof(
    recipientId: string,
    methodId: string,
    proof: WalletProof,
  ): Promise<WalletProofAccepted>;
  requestActivation(recipientId: string, methodId: string): Promise<ActivationOffer>;
  submitActivation(activationId: string, signedTransaction: string): Promise<ActivationLanded>;
}

/** The API said no, in its own words. */
export class ApiProblem extends Error {
  override readonly name = 'ApiProblem';
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.code);
    this.problem = problem;
  }
}

/** The answer could not be read: no network, or a body that is not the contract. */
export class ApiUnreachable extends Error {
  override readonly name = 'ApiUnreachable';
}

export interface HttpClientOptions {
  /** Where the API is, such as https://api.example; no trailing path. */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function httpClient(options: HttpClientOptions): OnboardingClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(
    schema: z.ZodMiniType<T>,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'omit',
      });
    } catch (error) {
      throw new ApiUnreachable('the request did not reach UJIRA', { cause: error });
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const problem = Problem.safeParse(json);
      if (problem.success) throw new ApiProblem(problem.data);
      throw new ApiUnreachable(`status ${String(response.status)} without a problem body`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiUnreachable(`${path} answered outside its contract`);
    return parsed.data;
  }

  const recipient = (id: string): string => `/v1/embed/recipients/${segment(id)}`;
  const method = (id: string, methodId: string): string =>
    `${recipient(id)}/methods/${segment(methodId)}`;

  return {
    session: () => call(OnboardingSession, 'GET', '/v1/embed/onboarding'),
    addMethod: (id, body) =>
      call(SavedMethod, 'POST', `${recipient(id)}/methods`, {
        method: body.method,
        destination: {
          network: body.destination.network,
          address: body.destination.address,
          ...(body.destination.memo === undefined
            ? {}
            : { memoType: 'id', memo: body.destination.memo }),
        },
      }),
    createWalletChallenge: (id, methodId) =>
      call(WalletChallenge, 'POST', `${method(id, methodId)}/wallet-challenges`),
    submitWalletProof: (id, methodId, proof) =>
      call(WalletProofAccepted, 'POST', `${method(id, methodId)}/wallet-proofs`, proof),
    requestActivation: (id, methodId) =>
      call(ActivationOffer, 'POST', `${method(id, methodId)}/activations`),
    submitActivation: (activationId, signedTransaction) =>
      call(ActivationLanded, 'POST', `/v1/embed/activations/${segment(activationId)}/submissions`, {
        signedTransaction,
      }),
  };
}
