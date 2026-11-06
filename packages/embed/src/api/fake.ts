// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A stand-in for the UJIRA API, for tests and the browser test server. It
// keeps the contract's rules: it refuses what the real onboarding refuses,
// answers with the same problem codes, and holds a wallet unreceivable until
// it has been activated. Nothing here is imported by the widget itself.

import { readWalletDestination } from '../destination.js';
import {
  UNSUPPORTED_MEMO_DETAIL,
  type ApiMethod,
  type OnboardingSession,
  type ReceivabilityReason,
} from './contract.js';
import { ApiProblem, type OnboardingClient } from './client.js';

/** Testnet's USDC issuer, which is public. Paying it would burn the amount. */
export const FAKE_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** The one recipient the fake knows. */
export const FAKE_RECIPIENT = '6a1f0e1c-55a4-4f0e-9b65-2f9d6c3b8a10';

/** A signature the fake treats as made by the wrong key. */
export const WRONG_SIGNATURE = 'wrong-key';

export interface FakeScenario {
  country: string;
  methods: readonly ApiMethod[];
  activationOffered: boolean;
  /** Why the wallet cannot receive before activation, or null when it can. */
  receivability: ReceivabilityReason | null;
  /** Whether the signing key is a current signer of the account. */
  signerAuthorized: boolean;
}

export const BASE_SCENARIO: FakeScenario = {
  country: 'KE',
  methods: ['stellar_wallet'],
  activationOffered: false,
  receivability: null,
  signerAuthorized: true,
};

function problem(status: number, code: string, detail?: string): ApiProblem {
  return new ApiProblem({
    status,
    code,
    requestId: 'req_fake_0001',
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Runs a step and hands back its result or its refusal as a promise. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** One call the fake answered, for tests to read. */
export interface FakeCall {
  name: keyof OnboardingClient;
  args: readonly unknown[];
}

export type FakeClient = OnboardingClient & { readonly calls: FakeCall[] };

export function fakeClient(scenario: Partial<FakeScenario> = {}): FakeClient {
  const world: FakeScenario = { ...BASE_SCENARIO, ...scenario };
  const calls: FakeCall[] = [];
  const methods = new Set<string>();
  const challenges = new Set<string>();
  let activated = false;
  let counter = 0;
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, '0')}`;
  };
  const knownMethod = (recipientId: string, methodId: string): void => {
    if (recipientId !== FAKE_RECIPIENT || !methods.has(methodId)) {
      throw problem(404, 'NOT_FOUND');
    }
  };
  const session: OnboardingSession = {
    recipientId: FAKE_RECIPIENT,
    country: world.country,
    network: 'stellar:testnet',
    methods: [...world.methods],
    neverPayable: [FAKE_ISSUER],
    activation: { offered: world.activationOffered },
  };

  return {
    calls,
    session: () =>
      settle(() => {
        calls.push({ name: 'session', args: [] });
        return structuredClone(session);
      }),
    addMethod: (recipientId, body) =>
      settle(() => {
        calls.push({ name: 'addMethod', args: [recipientId, body] });
        if (recipientId !== FAKE_RECIPIENT) throw problem(404, 'NOT_FOUND');
        if (!world.methods.includes(body.method)) throw problem(422, 'DESTINATION_INVALID');
        const read = readWalletDestination(
          body.destination.address,
          body.destination.memo ?? '',
          session.neverPayable,
        );
        if (!read.ok) {
          const memo = read.problem === 'destination.memo.unsupported';
          throw problem(422, 'DESTINATION_INVALID', memo ? UNSUPPORTED_MEMO_DETAIL : undefined);
        }
        const id = next('method');
        methods.add(id);
        return { id, method: body.method, status: 'active' as const };
      }),
    createWalletChallenge: (recipientId, methodId) =>
      settle(() => {
        calls.push({ name: 'createWalletChallenge', args: [recipientId, methodId] });
        knownMethod(recipientId, methodId);
        const challengeId = next('challenge');
        challenges.add(challengeId);
        return {
          challengeId,
          message: `example.com asks you to confirm your payout address.\nNonce: ${challengeId}`,
          nonce: challengeId,
          expiresAt: '2026-11-05T12:05:00.000Z',
        };
      }),
    submitWalletProof: (recipientId, methodId, proof) =>
      settle(() => {
        calls.push({ name: 'submitWalletProof', args: [recipientId, methodId, proof] });
        knownMethod(recipientId, methodId);
        if (!challenges.delete(proof.challengeId)) throw problem(422, 'WALLET_PROOF_EXPIRED');
        if (proof.signature === WRONG_SIGNATURE) throw problem(422, 'WALLET_PROOF_INVALID');
        if (!world.signerAuthorized) throw problem(422, 'WALLET_SIGNER_NOT_AUTHORIZED');
        if (world.receivability !== null && !activated) {
          throw problem(422, 'DESTINATION_NOT_RECEIVABLE', world.receivability);
        }
        return { verificationId: next('verification'), level: 'wallet_signature' as const };
      }),
    requestActivation: (recipientId, methodId) =>
      settle(() => {
        calls.push({ name: 'requestActivation', args: [recipientId, methodId] });
        knownMethod(recipientId, methodId);
        if (!world.activationOffered) throw problem(404, 'NOT_FOUND');
        return {
          activationId: next('activation'),
          transaction: 'AAAAAgAAAAB-unsigned-envelope',
          networkPassphrase: 'Test SDF Network ; September 2015',
          expiresAt: '2026-11-05T12:05:00.000Z',
        };
      }),
    submitActivation: (activationId, signedTransaction) =>
      settle(() => {
        calls.push({ name: 'submitActivation', args: [activationId, signedTransaction] });
        if (signedTransaction === '') throw problem(400, 'INVALID_REQUEST');
        activated = true;
        return { status: 'landed' as const };
      }),
  };
}
