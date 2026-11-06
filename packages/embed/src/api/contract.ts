// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the widget reads from UJIRA, checked before anything uses it. The
// shapes follow the API's own schemas for the same resources, kept here in
// the small validator build so the widget stays inside its size budget. A
// test parses the API's fixtures with these, so the two cannot drift apart
// without a failing test.
//
// Objects are read leniently: a field the API adds later is dropped rather
// than refused, so a widget already on someone's page keeps working.

import * as z from 'zod/mini';

/** The API's names for the payout methods. */
export const API_METHODS = ['stellar_wallet', 'bank', 'mobile_money', 'cash_pickup'] as const;
export type ApiMethod = (typeof API_METHODS)[number];

const Text = z.string().check(z.minLength(1), z.maxLength(4_096));

/** What the widget needs to know before the first question. */
export const OnboardingSession = z.object({
  recipientId: Text,
  /** ISO 3166-1 alpha-2, the corridor the recipient is paid in. */
  country: z.string().check(z.regex(/^[A-Z]{2}$/)),
  /** The network a wallet destination is on, such as stellar:testnet. */
  network: Text,
  /** The methods a signed partner pays out in this corridor. */
  methods: z.array(z.enum(API_METHODS)).check(z.maxLength(10)),
  /** Addresses a payout would burn, such as the USDC issuer. Public data. */
  neverPayable: z.array(Text).check(z.maxLength(100)),
  /** Whether UJIRA pays to activate this recipient's wallet. */
  activation: z.object({ offered: z.boolean() }),
});
export type OnboardingSession = z.infer<typeof OnboardingSession>;

export const SavedMethod = z.object({
  id: Text,
  method: z.enum(API_METHODS),
  status: z.enum(['active', 'disabled']),
});
export type SavedMethod = z.infer<typeof SavedMethod>;

export const WalletChallenge = z.object({
  challengeId: Text,
  /** The exact text for the wallet to sign. */
  message: Text,
  nonce: Text,
  expiresAt: Text,
});
export type WalletChallenge = z.infer<typeof WalletChallenge>;

export const WalletProofAccepted = z.object({
  verificationId: Text,
  level: z.literal('wallet_signature'),
});
export type WalletProofAccepted = z.infer<typeof WalletProofAccepted>;

/** A transaction for the recipient's wallet to sign, which UJIRA pays for. */
export const ActivationOffer = z.object({
  activationId: Text,
  /** Base64 transaction envelope. */
  transaction: Text,
  networkPassphrase: Text,
  expiresAt: Text,
});
export type ActivationOffer = z.infer<typeof ActivationOffer>;

export const ActivationLanded = z.object({ status: z.literal('landed') });
export type ActivationLanded = z.infer<typeof ActivationLanded>;

/** RFC 9457 problem details. `code` is what the widget branches on. */
export const Problem = z.object({
  status: z.number(),
  code: z.string().check(z.maxLength(64)),
  detail: z.optional(z.string().check(z.maxLength(1_000))),
  requestId: z.optional(z.string().check(z.maxLength(128))),
});
export type Problem = z.infer<typeof Problem>;

/**
 * The detail the API sends with DESTINATION_INVALID for a destination that
 * needs a text or hash memo. The code is shared with every other refused
 * destination, so this text is what tells the two apart; a test pins it to
 * the API's own constant.
 */
export const UNSUPPORTED_MEMO_DETAIL =
  'This destination needs a text or hash memo, which a payout from a mandate cannot carry. Choose another payout method, or an address that needs no memo or only a numeric one.';

/** Why a wallet cannot receive yet, sent as the detail of DESTINATION_NOT_RECEIVABLE. */
export const RECEIVABILITY_REASONS = [
  'ACCOUNT_NOT_FOUND',
  'DESTINATION_IS_ISSUER',
  'NO_TRUSTLINE',
  'TRUSTLINE_NOT_AUTHORIZED',
  'TRUSTLINE_LIMIT',
] as const;
export type ReceivabilityReason = (typeof RECEIVABILITY_REASONS)[number];

export function isReceivabilityReason(text: string | undefined): text is ReceivabilityReason {
  return (RECEIVABILITY_REASONS as readonly (string | undefined)[]).includes(text);
}
