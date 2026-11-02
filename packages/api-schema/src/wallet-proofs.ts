// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A recipient proving they control a payout destination: UJIRA issues a
// challenge, the wallet signs it, and the proof comes back with the text and
// the nonce, because UJIRA keeps only their hashes.

import { z } from 'zod';

import { Timestamp, Uuid } from './common.js';

export const WalletChallenge = z.strictObject({
  challengeId: Uuid,
  /** The exact text for the wallet to sign. */
  message: z.string().min(1),
  nonce: z.string().min(1),
  expiresAt: Timestamp,
});
export type WalletChallenge = z.infer<typeof WalletChallenge>;

export const WalletProofRequest = z.strictObject({
  challengeId: Uuid,
  message: z.string().min(1).max(4_096),
  nonce: z.string().min(1).max(128),
  signature: z.string().min(1).max(2_048),
  /** The key that signed, when it is not the account's own. */
  signer: z
    .string()
    .regex(/^[A-Za-z0-9]{1,128}$/)
    .optional(),
});
export type WalletProofRequest = z.infer<typeof WalletProofRequest>;

export const WalletProofAccepted = z.strictObject({
  verificationId: Uuid,
  level: z.literal('wallet_signature'),
  signerKey: z.string().min(1),
});
export type WalletProofAccepted = z.infer<typeof WalletProofAccepted>;
