// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A destination is only attested after the recipient proves they control it.
// This flow issues a single use challenge for a payout method and records the
// evidence once a signature over it verifies and the destination can actually
// receive, so a destination that cannot be paid is never recorded as verified.
//
// A proof that fails leaves the challenge open until it expires: a recipient
// who adds a missing trustline can send the same signature again. Only a
// recorded proof consumes it.

import { createHash, randomUUID } from 'node:crypto';

import type { Destination, UnixSeconds, Uuid } from '@ujira/chain-adapter';
import { isChainAdapterError } from '@ujira/chain-adapter';
import { z } from 'zod';

import {
  CallTimeoutError,
  IdentityInputError,
  ProviderUnavailableError,
  WalletMethodNotFoundError,
  issuesOf,
} from '../errors.js';
import { sameDestination } from '../evidence.js';
import { assertScope, checkedScope } from '../service.js';
import { withTimeout } from '../timeout.js';
import type { DestinationVerificationRecord, IdentityContext } from '../types.js';

import type { WalletChallengeRecord, WalletProofInvalidReason, WalletProofPorts } from './ports.js';
import { WALLET_PROOF_PURPOSE } from './ports.js';

/** How long a recipient has to sign and send back a challenge. */
export const WALLET_CHALLENGE_TTL_SECONDS = 600;

export const WALLET_PROOF_REFUSALS = Object.freeze([
  'WALLET_PROOF_INVALID',
  'WALLET_PROOF_EXPIRED',
  'WALLET_SIGNER_NOT_AUTHORIZED',
  'DESTINATION_NOT_RECEIVABLE',
] as const);
export type WalletProofRefusal = (typeof WALLET_PROOF_REFUSALS)[number];

export interface CreateWalletChallengeRequest {
  /** The recipient the method must belong to. */
  readonly recipientId: Uuid;
  readonly methodId: Uuid;
}

export interface IssuedWalletChallenge {
  readonly challengeId: Uuid;
  /** The exact text for the wallet to sign. */
  readonly message: string;
  /** Sent back with the proof. Only its hash is kept here. */
  readonly nonce: string;
  readonly expiresAt: UnixSeconds;
}

export interface SubmitWalletProofRequest {
  readonly challengeId: Uuid;
  readonly message: string;
  readonly nonce: string;
  readonly signature: string;
  /** The key that signed, when it is not the account's own. */
  readonly signer?: string | undefined;
}

export type SubmitWalletProofResult =
  | {
      readonly accepted: true;
      readonly verificationId: Uuid;
      readonly signerKey: string;
    }
  | {
      readonly accepted: false;
      readonly code: WalletProofRefusal;
      /** The narrower cause, a code from a closed list, or null. */
      readonly reason: string | null;
    };

export interface WalletProofFlow {
  createWalletChallenge(
    ctx: IdentityContext,
    req: CreateWalletChallengeRequest,
  ): Promise<IssuedWalletChallenge>;
  /** Throws ProviderUnavailableError when the chain cannot answer; a refusal is a result. */
  submitWalletProof(
    ctx: IdentityContext,
    req: SubmitWalletProofRequest,
  ): Promise<SubmitWalletProofResult>;
}

const createSchema = z.strictObject({ recipientId: z.uuid(), methodId: z.uuid() });

const submitSchema = z.strictObject({
  challengeId: z.uuid(),
  message: z.string().min(1).max(4_096),
  nonce: z.string().min(1).max(128),
  // The verification table caps a stored signature at this length.
  signature: z.string().min(1).max(2_048),
  signer: z
    .string()
    .regex(/^[A-Za-z0-9]{1,128}$/)
    .optional(),
});

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function refuse(code: WalletProofRefusal, reason: string | null = null): SubmitWalletProofResult {
  return { accepted: false, code, reason };
}

// What each way a proof can fail means to the caller. The account being gone
// is a fact about the destination, not about the signature.
function refusalFor(reason: WalletProofInvalidReason): SubmitWalletProofResult {
  if (reason === 'EXPIRED') return refuse('WALLET_PROOF_EXPIRED');
  if (reason === 'SIGNER_NOT_AUTHORIZED') return refuse('WALLET_SIGNER_NOT_AUTHORIZED');
  if (reason === 'ACCOUNT_NOT_FOUND') return refuse('DESTINATION_NOT_RECEIVABLE', reason);
  return refuse('WALLET_PROOF_INVALID', reason);
}

/** A chain outage is worth another try; any other failure is a fault and is thrown as it is. */
function asOutage(error: unknown): unknown {
  return error instanceof CallTimeoutError || (isChainAdapterError(error) && error.retryable)
    ? new ProviderUnavailableError({ cause: error })
    : error;
}

function destinationOf(challenge: WalletChallengeRecord): Destination {
  return {
    address: { network: challenge.network, value: challenge.address },
    tag: challenge.tag,
  };
}

export function createWalletProofFlow(ports: WalletProofPorts): WalletProofFlow {
  const { store, proofs } = ports;

  return {
    async createWalletChallenge(ctx, raw) {
      const scope = checkedScope(ctx);
      const parsed = createSchema.safeParse(raw);
      if (!parsed.success) throw new IdentityInputError(issuesOf(parsed.error));
      const recipientId = parsed.data.recipientId as Uuid;
      const [recipient, method] = await Promise.all([
        store.recipient(scope, recipientId),
        store.payoutMethod(scope, parsed.data.methodId as Uuid),
      ]);
      assertScope(scope, [recipient, method]);
      if (recipient === null || method?.status !== 'active' || method.recipientId !== recipientId) {
        throw new WalletMethodNotFoundError();
      }

      const requestId = randomUUID();
      const issued = ports.chain(method.network).walletProofChallenge({
        network: method.network,
        address: method.destination.address.value,
        purpose: WALLET_PROOF_PURPOSE,
        recipientRef: recipient.recipientRef,
        tag: method.destination.tag,
        requestId,
        ttlSeconds: WALLET_CHALLENGE_TTL_SECONDS,
      });
      const expiresAt = (ports.clock.nowSeconds() +
        BigInt(WALLET_CHALLENGE_TTL_SECONDS)) as UnixSeconds;
      const challengeId = randomUUID() as Uuid;
      await proofs.insertChallenge({
        scope,
        id: challengeId,
        methodId: method.id,
        purpose: WALLET_PROOF_PURPOSE,
        network: method.network,
        address: method.destination.address.value,
        tag: method.destination.tag,
        recipientRef: recipient.recipientRef,
        requestId,
        nonceHash: sha256Hex(issued.nonce),
        messageHash: sha256Hex(issued.text),
        issuedAtText: issued.issuedAt,
        expiresAtText: issued.expiresAt,
        expiresAt,
        consumedAt: null,
      });
      return { challengeId, message: issued.text, nonce: issued.nonce, expiresAt };
    },

    async submitWalletProof(ctx, raw) {
      const scope = checkedScope(ctx);
      const parsed = submitSchema.safeParse(raw);
      if (!parsed.success) throw new IdentityInputError(issuesOf(parsed.error));
      const req = parsed.data;

      const challenge = await proofs.challenge(scope, req.challengeId as Uuid);
      assertScope(scope, [challenge]);
      if (challenge === null) return refuse('WALLET_PROOF_INVALID');
      if (challenge.consumedAt !== null) return refuse('WALLET_PROOF_INVALID', 'ALREADY_USED');
      const now = ports.clock.nowSeconds();
      if (now >= challenge.expiresAt) return refuse('WALLET_PROOF_EXPIRED');
      if (
        sha256Hex(req.nonce) !== challenge.nonceHash ||
        sha256Hex(req.message) !== challenge.messageHash
      ) {
        return refuse('WALLET_PROOF_INVALID', 'MESSAGE_MISMATCH');
      }

      // The method may have changed since the challenge was issued, and a
      // proof only speaks for the destination it was made for.
      const destination = destinationOf(challenge);
      const method = await store.payoutMethod(scope, challenge.methodId);
      assertScope(scope, [method]);
      if (method?.status !== 'active' || !sameDestination(method.destination, destination)) {
        return refuse('WALLET_PROOF_INVALID', 'METHOD_CHANGED');
      }

      const chain = ports.chain(challenge.network);
      const ms = ports.config().attestation.callTimeoutMs;
      const signerInput = req.signer === undefined ? {} : { signer: req.signer };
      let signer: string;
      let scheme: string;
      try {
        const verdict = await withTimeout(ms, ctx.signal, (signal) =>
          chain.verifyWalletProof(
            {
              challenge: {
                network: challenge.network,
                address: challenge.address,
                purpose: challenge.purpose,
                recipientRef: challenge.recipientRef,
                tag: challenge.tag,
                requestId: challenge.requestId,
                text: req.message,
                nonce: req.nonce,
                issuedAt: challenge.issuedAtText,
                expiresAt: challenge.expiresAtText,
              },
              signedText: req.message,
              signature: req.signature,
              ...signerInput,
            },
            { correlationId: ctx.correlationId, signal },
          ),
        );
        if (verdict.status === 'invalid') return refusalFor(verdict.reason);
        ({ signer, scheme } = verdict);

        // Before any row is written, so what cannot receive is never verified.
        const check = await withTimeout(ms, ctx.signal, (signal) =>
          chain.checkDestination(
            { destination, asset: ports.payoutAsset, proofSigner: signer },
            { correlationId: ctx.correlationId, signal },
          ),
        );
        if (!check.receivable) return refuse('DESTINATION_NOT_RECEIVABLE', check.reason);
        if (check.proofSigner !== 'current') return refuse('WALLET_SIGNER_NOT_AUTHORIZED');
      } catch (error) {
        throw asOutage(error);
      }

      const verification: DestinationVerificationRecord = {
        scope,
        id: randomUUID() as Uuid,
        methodId: challenge.methodId,
        level: 'wallet_signature',
        destination,
        signerKey: signer,
        derivedFrom: null,
        recordedAt: now,
        scheme,
        challengeId: challenge.id,
        signature: req.signature,
        partnerRef: null,
      };
      const recorded = await proofs.recordProof(scope, challenge.id, now, verification);
      if (recorded === 'already_consumed') return refuse('WALLET_PROOF_INVALID', 'ALREADY_USED');
      return { accepted: true, verificationId: verification.id, signerKey: signer };
    },
  };
}
