// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Verifies a wallet proof on Stellar: the challenge text signed per SEP-53
// by a key that may sign for the account today. The account comes from a
// ledger read the caller passes in, so the rules are the same whichever RPC
// read it.

import { decodeAccountAddress, isAccountAddress } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { CallOptions } from '../types.js';
import { challengeSeconds } from '../wallet-proof.js';
import type {
  VerifyWalletProofRequest,
  WalletProofInvalidReason,
  WalletProofResult,
} from '../wallet-proof.js';
import { isCurrentSigner } from './account-rules.js';
import type { StellarAccountEntry } from './account-rules.js';
import { readStellarAccount } from './check-destination.js';
import type { StellarLedgerReader } from './check-destination.js';
import { parseStellarDestination } from './parse-destination.js';
import { verifySep53 } from './sep53.js';

export const WALLET_PROOF_SCHEME = 'sep53';

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
  req: VerifyWalletProofRequest,
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

/**
 * Reads the account behind the proven address and verifies against it. An
 * address with no key to sign with needs no read: the answer is already
 * UNSUPPORTED_ACCOUNT.
 */
export async function checkStellarWalletProof(
  network: StellarNetworkId,
  req: VerifyWalletProofRequest,
  ledger: StellarLedgerReader,
  nowSeconds: bigint,
  opts: CallOptions,
): Promise<WalletProofResult> {
  if (req.challenge.network !== network) {
    throw new InvalidInputError({ issues: ['walletProof.network (mismatch)'] });
  }
  const accountId = proofAccountOf(network, req.challenge.address);
  const account =
    accountId === null ? null : await readStellarAccount(network, accountId, ledger, opts);
  return verifyStellarWalletProof(network, req, { account }, nowSeconds);
}
