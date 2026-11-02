// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Whether a destination can receive a payout, and whether a proof's signer
// is still current, from one ledger read. Classic account and trustline
// entries never archive, so an absent entry is truly absent and needs no
// restore check.

import { z } from 'zod';

import { isContractAddress } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { CallOptions, DestinationCheck, ProofSignerStatus } from '../types.js';
import {
  isCurrentSigner,
  receivability,
  stellarAccountEntrySchema,
  stellarTrustlineEntrySchema,
} from './account-rules.js';
import type { StellarAccountEntry, StellarAsset, StellarTrustlineEntry } from './account-rules.js';
import { parseStellarDestination } from './parse-destination.js';

export type StellarLedgerKey =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'trustline'; readonly accountId: string; readonly asset: StellarAsset };

export type StellarLedgerEntry =
  | ({ readonly kind: 'account' } & StellarAccountEntry)
  | ({ readonly kind: 'trustline' } & StellarTrustlineEntry);

/**
 * The read the transport implements with one getLedgerEntries call: every
 * key in one request, an entry or null per key, in key order, decoded.
 */
export interface StellarLedgerReader {
  getLedgerEntries(
    network: StellarNetworkId,
    keys: readonly StellarLedgerKey[],
    opts: CallOptions,
  ): Promise<readonly (StellarLedgerEntry | null)[]>;
}

export interface StellarCheckDestinationRequest {
  /** As the recipient gave it: a G, an M or a C. */
  readonly destination: string;
  readonly asset: StellarAsset;
  /** Stroops. Checked against the trustline's room when given. */
  readonly amount?: bigint;
  /** The key a wallet proof was signed with, to check it is still current. */
  readonly proofSigner?: string;
}

const accountEntry = stellarAccountEntrySchema.extend({ kind: z.literal('account') });
const trustlineEntry = stellarTrustlineEntrySchema.extend({ kind: z.literal('trustline') });
const entries = z.tuple([accountEntry.nullable(), trustlineEntry.nullable()]);
const accountOnly = z.tuple([accountEntry.nullable()]);

/** The account entry of `accountId` from one read, or null when it does not exist. */
export async function readStellarAccount(
  network: StellarNetworkId,
  accountId: string,
  ledger: StellarLedgerReader,
  opts: CallOptions,
): Promise<StellarAccountEntry | null> {
  const answer = await ledger.getLedgerEntries(network, [{ kind: 'account', accountId }], opts);
  const parsed = accountOnly.safeParse(answer);
  if (!parsed.success) throw new InvalidInputError({ issues: ['ledgerEntries (invalid)'] });
  return parsed.data[0];
}

/**
 * Reads the account behind the destination and its trustline for the
 * payout asset in one call and applies the receivability and signer rules.
 * An M is read as its G. A C receives without a trustline and has no
 * signer to check, so it needs no read. An absent account is not
 * receivable and makes any proof signer not current.
 */
export async function checkStellarDestination(
  network: StellarNetworkId,
  req: StellarCheckDestinationRequest,
  ledger: StellarLedgerReader,
  opts: CallOptions,
): Promise<DestinationCheck> {
  const base = parseStellarDestination(network, { address: req.destination }).address.value;
  if (isContractAddress(base)) {
    return { receivable: true, proofSigner: 'not_applicable' };
  }
  const answer = await ledger.getLedgerEntries(
    network,
    [
      { kind: 'account', accountId: base },
      { kind: 'trustline', accountId: base, asset: req.asset },
    ],
    opts,
  );
  // The read is outside data, so its shape is checked before any rule
  // trusts it, and an entry for another account is a transport bug.
  const parsed = entries.safeParse(answer);
  if (!parsed.success) throw new InvalidInputError({ issues: ['ledgerEntries (invalid)'] });
  const [account, trustline] = parsed.data;
  if (
    (account !== null && account.accountId !== base) ||
    (trustline !== null &&
      (trustline.accountId !== base ||
        trustline.asset.code !== req.asset.code ||
        trustline.asset.issuer !== req.asset.issuer))
  ) {
    throw new InvalidInputError({ issues: ['ledgerEntries (mismatch)'] });
  }
  const result = receivability(base, account, trustline, req.asset, req.amount);
  const proofSigner: ProofSignerStatus =
    req.proofSigner === undefined
      ? 'not_applicable'
      : account !== null && isCurrentSigner(account, req.proofSigner)
        ? 'current'
        : 'not_current';
  return result.receivable
    ? { receivable: true, proofSigner }
    : { receivable: false, reason: result.reason, proofSigner };
}
