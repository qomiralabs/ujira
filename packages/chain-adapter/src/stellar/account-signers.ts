// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How many signatures a classic Stellar account needs to authorize a
// mandate call. The medium threshold is the level that counts, on both ways a
// principal can authorize: its own transaction, where the network checks the
// contract call operation against medium, and an auth entry on someone else's
// call, which the host checks against medium too. Counting against low or
// high would each give a wrong answer; stellar-signers.integration.test.ts
// measures it on testnet. An account whose master key alone meets medium is a
// single key principal, whatever other signers it lists.

import { StrKey } from '@stellar/stellar-base';

import { InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { CallOptions } from '../types.js';
import type { StellarLedgerReader } from './check-destination.js';

export interface StellarAccountSigners {
  /** The account's medium threshold, 0 to 255. */
  readonly mediumThreshold: number;
  /** Every signer with its weight, the master key included. */
  readonly signers: readonly { readonly key: string; readonly weight: number }[];
}

const isByte = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 255;

/**
 * The fewest signers whose weights together reach the medium threshold, or
 * null when no set of signers can (the account cannot authorize at all).
 * A threshold of 0 still takes one signature, as on the network.
 */
export function stellarMinimumSignatures(account: StellarAccountSigners): number | null {
  if (!isByte(account.mediumThreshold) || !account.signers.every((s) => isByte(s.weight))) {
    throw new InvalidInputError({ issues: ['account (out_of_range)'] });
  }
  const needed = Math.max(account.mediumThreshold, 1);
  const weights = account.signers
    .map((s) => s.weight)
    .filter((w) => w > 0)
    .sort((a, b) => b - a);
  let total = 0;
  for (const [index, weight] of weights.entries()) {
    total += weight;
    if (total >= needed) return index + 1;
  }
  return null;
}

/** How a principal signs, in the shape the principal key gate reads. */
export type StellarPrincipalSigning =
  | { readonly kind: 'single_key' }
  | { readonly kind: 'multisig'; readonly minSignatures: number }
  /** No account, or no set of its signers can authorize. It never qualifies. */
  | { readonly kind: 'unverified' };

/**
 * Reads a classic account principal's signers and thresholds off the ledger.
 * Every signer counts whatever its kind: a hash or pre-authorized transaction
 * signer can authorize alone just as a key can, so leaving one out could only
 * make an account look safer than it is.
 */
export async function readStellarPrincipalSigning(
  reader: StellarLedgerReader,
  network: StellarNetworkId,
  address: string,
  opts: CallOptions,
): Promise<StellarPrincipalSigning> {
  // A contract wallet has rules, not thresholds; its own reader handles it.
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new InvalidInputError({ network, issues: ['principal (not_an_account)'] });
  }
  const [entry] = await reader.getLedgerEntries(
    network,
    [{ kind: 'account', accountId: address }],
    opts,
  );
  if (entry?.kind !== 'account') return { kind: 'unverified' };
  const fewest = stellarMinimumSignatures({
    mediumThreshold: entry.thresholds.medium,
    signers: [{ key: address, weight: entry.masterWeight }, ...entry.signers],
  });
  if (fewest === null) return { kind: 'unverified' };
  return fewest === 1 ? { kind: 'single_key' } : { kind: 'multisig', minSignatures: fewest };
}
