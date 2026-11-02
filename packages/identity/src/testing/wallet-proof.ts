// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Stand-ins for the wallet proof flow: the chain calls it makes, the
// challenge table, and one active recipient with a wallet method, ready to
// prove it. The fake signature is the text's hash under the signer's name, so
// a test can sign correctly without a wallet and tamper with it on purpose.

import { createHash, randomBytes } from 'node:crypto';

import type { TenantScope, UnixSeconds, Uuid } from '@ujira/chain-adapter';

import { parseIdentityConfig } from '../config.js';
import { IdentityConflictError } from '../errors.js';
import type { CheckDestinationRequest, DestinationCheck } from '../ports.js';
import type { DestinationVerificationRecord, IdentityContext } from '../types.js';
import type {
  VerifyWalletProofRequest,
  WalletChallenge,
  WalletChallengeRecord,
  WalletChallengeRequest,
  WalletProofChain,
  WalletProofInvalidReason,
  WalletProofPorts,
  WalletProofStore,
  WalletProofVerdict,
} from '../wallet-proof/ports.js';
import { createWalletProofFlow } from '../wallet-proof/service.js';

import type { FakeFailure } from './attestation.js';
import { ManualClock, methodRow, newScope, recipientRow } from './fixtures.js';
import { InMemoryIdentityStore, tenantKey } from './memory-store.js';

/** What the fake chain accepts as a signature over a text by a signer. */
export function fakeWalletSignature(text: string, signer: string): string {
  return createHash('sha256').update(`${signer}\n${text}`, 'utf8').digest('hex');
}

function failOrAnswer<T>(failure: FakeFailure | null, answer: () => T): Promise<T> {
  if (failure === 'hang') return new Promise<T>(() => undefined);
  if (failure !== null) return Promise.reject(failure);
  return Promise.resolve(answer());
}

export class FakeWalletProofChain implements WalletProofChain {
  /** The chain's answer about the destination, read fresh on every check. */
  destination: DestinationCheck = { receivable: true, proofSigner: 'current' };
  /** Forces a verdict the fake would not reach on its own, such as a removed signer. */
  verdict: WalletProofInvalidReason | null = null;
  verifyFailure: FakeFailure | null = null;
  checkFailure: FakeFailure | null = null;
  readonly checks: CheckDestinationRequest[] = [];
  readonly verifications: VerifyWalletProofRequest[] = [];

  walletProofChallenge(req: WalletChallengeRequest): WalletChallenge {
    const { ttlSeconds, ...fields } = req;
    const nonce = randomBytes(10).toString('hex');
    const issuedAt = '2027-01-15T08:00:00Z';
    const expiresAt = `issued plus ${String(ttlSeconds)} seconds`;
    return {
      ...fields,
      nonce,
      issuedAt,
      expiresAt,
      text: [
        `test.host wants you to prove ${req.address} for ${req.purpose}`,
        `Nonce: ${nonce}`,
        `Resources: ${req.recipientRef} ${req.tag === null ? 'none' : req.tag.toString()}`,
      ].join('\n'),
    };
  }

  verifyWalletProof(req: VerifyWalletProofRequest): Promise<WalletProofVerdict> {
    this.verifications.push(req);
    return failOrAnswer<WalletProofVerdict>(this.verifyFailure, () => {
      if (this.verdict !== null) return { status: 'invalid', reason: this.verdict };
      const signer = req.signer ?? req.challenge.address;
      return req.signature === fakeWalletSignature(req.signedText, signer)
        ? { status: 'valid', scheme: 'sep53', signer }
        : { status: 'invalid', reason: 'BAD_SIGNATURE' };
    });
  }

  checkDestination(req: CheckDestinationRequest): Promise<DestinationCheck> {
    this.checks.push(req);
    return failOrAnswer(this.checkFailure, () => this.destination);
  }
}

/** The challenge table, writing its verifications to the identity store's. */
export class InMemoryWalletProofStore implements WalletProofStore {
  readonly #rows = new Map<string, WalletChallengeRecord>();
  readonly #store: InMemoryIdentityStore;

  constructor(store: InMemoryIdentityStore) {
    this.#store = store;
  }

  insertChallenge(row: WalletChallengeRecord): Promise<void> {
    for (const existing of this.#rows.values()) {
      if (existing.nonceHash === row.nonceHash) return Promise.reject(new IdentityConflictError());
    }
    this.#rows.set(`${tenantKey(row.scope)}/${row.id}`, row);
    return Promise.resolve();
  }

  challenge(scope: TenantScope, challengeId: Uuid): Promise<WalletChallengeRecord | null> {
    return Promise.resolve(this.#rows.get(`${tenantKey(scope)}/${challengeId}`) ?? null);
  }

  recordProof(
    scope: TenantScope,
    challengeId: Uuid,
    consumedAt: UnixSeconds,
    verification: DestinationVerificationRecord,
  ): Promise<'recorded' | 'already_consumed'> {
    const key = `${tenantKey(scope)}/${challengeId}`;
    const row = this.#rows.get(key);
    if (row === undefined || row.consumedAt !== null) return Promise.resolve('already_consumed');
    this.#rows.set(key, { ...row, consumedAt });
    this.#store.putVerification(verification);
    return Promise.resolve('recorded');
  }

  rows(scope: TenantScope): WalletChallengeRecord[] {
    const tenant = tenantKey(scope);
    return [...this.#rows.values()].filter((row) => tenantKey(row.scope) === tenant);
  }
}

export function walletProofWorld() {
  const scope = newScope();
  const ctx: IdentityContext = { scope, correlationId: 'trace-proof' };
  const store = new InMemoryIdentityStore();
  const proofs = new InMemoryWalletProofStore(store);
  const chain = new FakeWalletProofChain();
  const clock = new ManualClock();
  const recipient = recipientRow(scope);
  const method = methodRow(scope, recipient.id);
  store.putRecipient(recipient).putPayoutMethod(method);
  const config = parseIdentityConfig({ attestation: { callTimeoutMs: 150 } });
  const ports: WalletProofPorts = {
    store,
    proofs,
    chain: () => chain,
    clock,
    config: () => config,
    payoutAsset: 'USDC',
  };
  const flow = createWalletProofFlow(ports);
  return {
    scope,
    ctx,
    store,
    proofs,
    chain,
    clock,
    recipient,
    method,
    ports,
    flow,
    issue() {
      return flow.createWalletChallenge(ctx, { recipientId: recipient.id, methodId: method.id });
    },
    /** Signs an issued challenge as the destination's own key would. */
    proofOf(issued: Awaited<ReturnType<WalletProofWorldFlow['createWalletChallenge']>>) {
      return {
        challengeId: issued.challengeId,
        message: issued.message,
        nonce: issued.nonce,
        signature: fakeWalletSignature(issued.message, method.destination.address.value),
      };
    },
  };
}

type WalletProofWorldFlow = ReturnType<typeof createWalletProofFlow>;
export type WalletProofWorld = ReturnType<typeof walletProofWorld>;
