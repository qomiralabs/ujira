// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Verifies a wallet proof on Stellar: the challenge text signed per SEP-53
// by a key that may sign for the account today. The account comes from a
// ledger read the caller passes in, so the rules are the same whichever RPC
// read it.

import { decodeAccountAddress, isAccountAddress } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import { challengeSeconds } from '../wallet-proof.js';
import type { WalletProofChallenge } from '../wallet-proof.js';
import { isCurrentSigner } from './account-rules.js';
import type { StellarAccountEntry } from './account-rules.js';
import { parseStellarDestination } from './parse-destination.js';
import { verifySep53 } from './sep53.js';

export const WALLET_PROOF_SCHEME = 'sep53';

export type WalletProofInvalidReason =
  | 'BAD_SIGNATURE'
  | 'WRONG_SIGNER'
  | 'EXPIRED'
  | 'MESSAGE_MISMATCH'
  | 'UNSUPPORTED_ACCOUNT'
  | 'SIGNER_NOT_AUTHORIZED'
  | 'ACCOUNT_NOT_FOUND';

export type WalletProofResult =
  | {
      readonly status: 'valid';
      readonly scheme: typeof WALLET_PROOF_SCHEME;
      readonly signer: string;
    }
  | { readonly status: 'invalid'; readonly reason: WalletProofInvalidReason };

export interface StellarWalletProofRequest {
  /** The challenge as issued and stored, never as the client sent it back. */
  readonly challenge: WalletProofChallenge;
  /** The text the wallet says it signed. */
  readonly signedText: string;
  /** The 64 byte ed25519 signature, base64 as wallets return it. */
  readonly signature: string;
  /**
   * The G key the wallet reports signing with, for an account where an
   * added signer signs. Absent means the account's own key.
   */
  readonly signer?: string;
}

/** The account entry of the G behind the proven address, read at verification. */
export interface StellarWalletProofLedger {
  readonly account: StellarAccountEntry | null;
}

const BASE64 = /^[A-Za-z0-9+/]{86}==$/;

function invalid(reason: WalletProofInvalidReason): WalletProofResult {
  return { status: 'invalid', reason };
}

/**
 * The account a proven address stands for: a G as it is, the G behind an
 * M. A C has no key that could sign a message, so it is null. Throws
 * InvalidInputError for anything that is not a Stellar address.
 */
export function proofAccountOf(network: StellarNetworkId, address: string): string | null {
  const destination = parseStellarDestination(network, { address });
  const base = destination.address.value;
  return isAccountAddress(base) ? base : null;
}

/**
 * Checks, in order: the address can sign at all, the signed text is exactly
 * the issued challenge, the challenge has not expired, the reported signer
 * is an account key, the signature verifies under it, the account exists,
 * and the signer may sign for it today. The first failure is the reason.
 */
export function verifyStellarWalletProof(
  network: StellarNetworkId,
  req: StellarWalletProofRequest,
  ledger: StellarWalletProofLedger,
  nowSeconds: bigint,
): WalletProofResult {
  if (req.challenge.network !== network) {
    throw new InvalidInputError({ issues: ['walletProof.network (mismatch)'] });
  }
  const accountId = proofAccountOf(network, req.challenge.address);
  if (accountId === null) return invalid('UNSUPPORTED_ACCOUNT');
  if (req.signedText !== req.challenge.text) return invalid('MESSAGE_MISMATCH');
  if (nowSeconds >= challengeSeconds(req.challenge.expiresAt)) return invalid('EXPIRED');
  const signer = req.signer ?? accountId;
  // Only an ed25519 account key can sign a message, so a muxed, contract
  // or malformed signer is the wrong signer whatever the signature says.
  if (!isAccountAddress(signer)) return invalid('WRONG_SIGNER');
  if (!BASE64.test(req.signature)) return invalid('BAD_SIGNATURE');
  const signature = Buffer.from(req.signature, 'base64');
  if (!verifySep53(decodeAccountAddress(signer), req.signedText, signature)) {
    return invalid('BAD_SIGNATURE');
  }
  if (ledger.account === null) return invalid('ACCOUNT_NOT_FOUND');
  if (ledger.account.accountId !== accountId) {
    throw new InvalidInputError({ issues: ['walletProof.account (mismatch)'] });
  }
  if (!isCurrentSigner(ledger.account, signer)) return invalid('SIGNER_NOT_AUTHORIZED');
  return { status: 'valid', scheme: WALLET_PROOF_SCHEME, signer };
}
