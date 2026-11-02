// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the wallet proof flow is given. The challenge text and the signing
// scheme are the chain's, so both come through the chain adapter; this port is
// typed as the adapter's wallet proof methods are specified, so the flow does
// not wait on them. The store has an in-memory version in
// @ujira/identity/testing until the challenge table exists.

import type { CallOptions, NetworkId, TenantScope, UnixSeconds, Uuid } from '@ujira/chain-adapter';
import type { TokenAsset } from '@ujira/core';

import type { IdentityConfig } from '../config.js';
import type { CheckDestinationRequest, DestinationCheck, IdentityStore } from '../ports.js';
import type { DestinationVerificationRecord } from '../types.js';

export const WALLET_PROOF_PURPOSE = 'payout_destination';

export interface WalletChallengeRequest {
  readonly network: NetworkId;
  readonly address: string;
  readonly purpose: typeof WALLET_PROOF_PURPOSE;
  readonly recipientRef: string;
  readonly tag: bigint | null;
  readonly requestId: string;
  readonly ttlSeconds: number;
}

/** A challenge as the adapter issued it, with the text the wallet signs. */
export interface WalletChallenge extends Omit<WalletChallengeRequest, 'ttlSeconds'> {
  readonly text: string;
  readonly nonce: string;
  /** UTC, second precision, as the text states it. */
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type WalletProofInvalidReason =
  | 'BAD_SIGNATURE'
  | 'WRONG_SIGNER'
  | 'EXPIRED'
  | 'MESSAGE_MISMATCH'
  | 'UNSUPPORTED_ACCOUNT'
  | 'SIGNER_NOT_AUTHORIZED'
  | 'ACCOUNT_NOT_FOUND';

export type WalletProofVerdict =
  | { readonly status: 'valid'; readonly scheme: string; readonly signer: string }
  | { readonly status: 'invalid'; readonly reason: WalletProofInvalidReason };

export interface VerifyWalletProofRequest {
  readonly challenge: WalletChallenge;
  /** The text the wallet says it signed. */
  readonly signedText: string;
  readonly signature: string;
  /** The key the wallet reports signing with, for an account with added signers. */
  readonly signer?: string;
}

export interface WalletProofChain {
  /** Pure. The widget host in the text comes from the adapter's config, never a request. */
  walletProofChallenge(req: WalletChallengeRequest): WalletChallenge;
  verifyWalletProof(req: VerifyWalletProofRequest, opts: CallOptions): Promise<WalletProofVerdict>;
  /** Read fresh from the chain on every call, never cached. */
  checkDestination(req: CheckDestinationRequest, opts: CallOptions): Promise<DestinationCheck>;
}

/**
 * One issued challenge. The nonce and the text are kept as hashes only, so
 * the table cannot be read to answer an open challenge; the wallet's copy
 * comes back with the proof and must hash to these.
 */
export interface WalletChallengeRecord {
  readonly scope: TenantScope;
  readonly id: Uuid;
  readonly methodId: Uuid;
  readonly purpose: typeof WALLET_PROOF_PURPOSE;
  readonly network: NetworkId;
  readonly address: string;
  readonly tag: bigint | null;
  readonly recipientRef: string;
  readonly requestId: string;
  readonly nonceHash: string;
  readonly messageHash: string;
  /** As the text states them, to give the adapter the challenge it issued. */
  readonly issuedAtText: string;
  readonly expiresAtText: string;
  readonly expiresAt: UnixSeconds;
  readonly consumedAt: UnixSeconds | null;
}

export interface WalletProofStore {
  /** Unique on the nonce hash: throws IdentityConflictError. */
  insertChallenge(row: WalletChallengeRecord): Promise<void>;
  challenge(scope: TenantScope, challengeId: Uuid): Promise<WalletChallengeRecord | null>;
  /**
   * Consumes the challenge and appends the verification as one write, so a
   * challenge can only ever back one row, however many proofs race for it.
   */
  recordProof(
    scope: TenantScope,
    challengeId: Uuid,
    consumedAt: UnixSeconds,
    verification: DestinationVerificationRecord,
  ): Promise<'recorded' | 'already_consumed'>;
}

export interface WalletProofPorts {
  readonly store: IdentityStore;
  readonly proofs: WalletProofStore;
  chain(network: NetworkId): WalletProofChain;
  readonly clock: { nowSeconds(): UnixSeconds };
  readonly config: () => IdentityConfig;
  /** The asset a proven destination must be able to receive. */
  readonly payoutAsset: TokenAsset;
}
