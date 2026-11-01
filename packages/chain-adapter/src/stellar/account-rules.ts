// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a Stellar account's ledger entries say about a key and a payout.
// Pure functions over entries already read and decoded, so the same rules
// apply whichever RPC read them and can be tested without one.

import { z } from 'zod';

import { InvalidInputError } from '../errors.js';

/** A classic asset as a trustline names it. */
export interface StellarAsset {
  readonly code: string;
  readonly issuer: string;
}

export type StellarSignerKind = 'ed25519' | 'pre_auth_tx' | 'hash_x' | 'signed_payload';

export interface StellarSignerEntry {
  readonly kind: StellarSignerKind;
  /** The signer as a strkey: a G for ed25519, otherwise its own form. */
  readonly key: string;
  readonly weight: number;
}

/** The parts of an account entry the rules read. */
export interface StellarAccountEntry {
  readonly accountId: string;
  readonly masterWeight: number;
  readonly thresholds: { readonly low: number; readonly medium: number; readonly high: number };
  readonly signers: readonly StellarSignerEntry[];
}

/** The parts of a trustline entry the rules read. Amounts are stroops. */
export interface StellarTrustlineEntry {
  readonly accountId: string;
  readonly asset: StellarAsset;
  readonly balance: bigint;
  readonly limit: bigint;
  readonly buyingLiabilities: bigint;
  /** The raw trustline flags. */
  readonly flags: number;
}

// Trustline flags as the protocol defines them.
export const TRUSTLINE_AUTHORIZED = 1;
export const TRUSTLINE_AUTHORIZED_TO_MAINTAIN_LIABILITIES = 2;

const weight = z.int().min(0).max(255);
const int64 = z
  .bigint()
  .min(-(2n ** 63n))
  .max(2n ** 63n - 1n);

// Entries come from an RPC, so they are checked like any outside data.
export const stellarAccountEntrySchema = z.strictObject({
  accountId: z.string().min(1).max(64),
  masterWeight: weight,
  thresholds: z.strictObject({ low: weight, medium: weight, high: weight }),
  signers: z
    .array(
      z.strictObject({
        kind: z.enum(['ed25519', 'pre_auth_tx', 'hash_x', 'signed_payload']),
        key: z.string().min(1).max(256),
        weight,
      }),
    )
    .max(20),
});

export const stellarTrustlineEntrySchema = z.strictObject({
  accountId: z.string().min(1).max(64),
  asset: z.strictObject({ code: z.string().min(1).max(12), issuer: z.string().min(1).max(64) }),
  balance: int64,
  limit: int64,
  buyingLiabilities: int64,
  flags: z.int().min(0).max(0xffff_ffff),
});

/**
 * Whether `key` (a G address) may sign for `account` today. The account's
 * own key counts when its master weight is above zero. Any other key counts
 * only as an ed25519 signer with a weight above zero and at least the low
 * threshold. Pre-authorized transaction, hash-x and signed payload signers
 * never count: none of them is a key that could sign a message.
 */
export function isCurrentSigner(account: StellarAccountEntry, key: string): boolean {
  if (key === account.accountId) return account.masterWeight > 0;
  return account.signers.some(
    (signer) =>
      signer.kind === 'ed25519' &&
      signer.key === key &&
      signer.weight > 0 &&
      signer.weight >= account.thresholds.low,
  );
}

export type ReceivabilityReason =
  | 'ACCOUNT_NOT_FOUND'
  | 'DESTINATION_IS_ISSUER'
  | 'NO_TRUSTLINE'
  | 'TRUSTLINE_NOT_AUTHORIZED'
  | 'TRUSTLINE_LIMIT';

export type Receivability =
  | { readonly receivable: true }
  | { readonly receivable: false; readonly reason: ReceivabilityReason };

/**
 * Whether an account can receive `amount` stroops of `asset`, or why not.
 * The issuer is refused, since an asset sent to its issuer is destroyed.
 * The trustline must exist and be fully authorized (authorized to maintain
 * liabilities only cannot receive), and with an amount, the room left under
 * its limit after the balance and buying liabilities must cover it.
 */
export function receivability(
  accountId: string,
  account: StellarAccountEntry | null,
  trustline: StellarTrustlineEntry | null,
  asset: StellarAsset,
  amount?: bigint,
): Receivability {
  if (account === null) return { receivable: false, reason: 'ACCOUNT_NOT_FOUND' };
  if (accountId === asset.issuer) return { receivable: false, reason: 'DESTINATION_IS_ISSUER' };
  if (trustline === null) return { receivable: false, reason: 'NO_TRUSTLINE' };
  if ((trustline.flags & TRUSTLINE_AUTHORIZED) === 0) {
    return { receivable: false, reason: 'TRUSTLINE_NOT_AUTHORIZED' };
  }
  if (amount !== undefined) {
    if (amount <= 0n) throw new InvalidInputError({ issues: ['amount (out_of_range)'] });
    const room = trustline.limit - trustline.balance - trustline.buyingLiabilities;
    if (room < amount) return { receivable: false, reason: 'TRUSTLINE_LIMIT' };
  }
  return { receivable: true };
}
