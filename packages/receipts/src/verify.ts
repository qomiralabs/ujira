// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Anyone holding a receipt can check it without trusting UJIRA: the number and
// a code printed on the receipt find it, the document is checked against its
// hash, and the payment is checked on the network that settled it. Whoever asks
// gets the recipient view and the result, and the type below has no room for
// anything else, so a public caller can never be handed the mandate, the
// principal or a destination tag.

import { createHash, timingSafeEqual } from 'node:crypto';

import { isChainAdapterError } from '@ujira/chain-adapter';
import type { CallOptions, ChainAdapter, ChainReceipt, NetworkId } from '@ujira/chain-adapter';

import { documentSha256 } from './document.js';
import { ReceiptChainTimeoutError } from './errors.js';
import { chainCall } from './issue.js';
import type { StoredReceipt } from './issue.js';
import type { Receipt } from './model.js';
import { recipientView } from './views.js';
import type { NetworkPresentation, RecipientReceiptView } from './views.js';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_LENGTH = 20;

/** The shape of a verification code: 100 bits, in characters nobody misreads. */
export const VERIFICATION_CODE = /^[A-Z2-7]{20}$/;

/**
 * The code printed on one revision of a receipt. Derived from the document
 * hash, so there is nothing more to store, and a correction gets its own. It
 * only proves the caller has seen the receipt: it unlocks nothing the recipient
 * view does not already say.
 */
export function verificationCodeFor(hash: string): string {
  const digest = createHash('sha256').update(`ujira:receipt-code:v1:${hash}`).digest();
  return Array.from(digest.subarray(0, CODE_LENGTH), (byte) =>
    CODE_ALPHABET.charAt(byte % 32),
  ).join('');
}

export interface PublicReceiptPorts {
  /**
   * A platform read, since the caller has no tenant: receipt numbers are unique
   * across every tenant. The revision the number names, or null.
   */
  byNumber(receiptNumber: string): Promise<StoredReceipt | null>;
  adapter(network: NetworkId): Pick<ChainAdapter, 'verifyReceipt'>;
  readonly networks: NetworkPresentation;
  /** Deadline for the chain check. */
  readonly chainTimeoutMs: number;
}

export interface PublicVerificationRequest {
  readonly receiptNumber: string;
  readonly code: string;
  readonly locale: string;
}

/**
 * What a public caller learns. Reasons are worded for someone paid in local
 * currency too, so they name no chain. `document_changed` shows no receipt,
 * because what is stored can no longer be believed.
 */
export type PublicVerification =
  | { readonly status: 'verified'; readonly reason: null; readonly receipt: RecipientReceiptView }
  | {
      readonly status: 'failed';
      readonly reason: 'not_confirmed';
      readonly receipt: RecipientReceiptView;
    }
  | { readonly status: 'failed'; readonly reason: 'document_changed'; readonly receipt: null }
  /** The check could not be made just now, which says nothing about the receipt. */
  | {
      readonly status: 'unavailable';
      readonly reason: null;
      readonly receipt: RecipientReceiptView;
    };

function sameCode(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether what verified on chain is what the receipt says. */
function matches(receipt: Receipt, onChain: ChainReceipt): boolean {
  // One settlement token today. Read as plain strings, the check still guards
  // a second one when it is added.
  const [chainAsset, receiptAsset]: string[] = [onChain.total.asset, receipt.total.asset];
  if (
    onChain.ref !== receipt.receiptRef ||
    onChain.network !== receipt.network ||
    chainAsset !== receiptAsset ||
    onChain.total.amount !== receipt.total.amount ||
    onChain.legs.length !== receipt.legs.length
  ) {
    return false;
  }
  return receipt.legs.every((leg) => {
    const chainLeg = onChain.legs.find((candidate) => candidate.index === leg.index);
    return (
      chainLeg?.amount.amount === leg.amount.amount &&
      (chainLeg.tag ?? null) === leg.destination.tag
    );
  });
}

/**
 * Checks a receipt for anyone who holds it. Null for an unknown number or a
 * wrong code alike, so neither tells a stranger whether a number exists. A
 * document that no longer matches its hash fails before the chain is asked. An
 * outage or a deadline answers 'unavailable' rather than failing, since it says
 * nothing about the receipt; any other error passes through.
 */
export async function verifyPublicReceipt(
  ports: PublicReceiptPorts,
  req: PublicVerificationRequest,
  opts: CallOptions,
): Promise<PublicVerification | null> {
  const stored = await ports.byNumber(req.receiptNumber);
  if (stored === null) return null;
  if (!sameCode(req.code, verificationCodeFor(stored.documentSha256))) return null;
  const { receipt } = stored;
  if (documentSha256(receipt) !== stored.documentSha256) {
    return { status: 'failed', reason: 'document_changed', receipt: null };
  }
  const view = recipientView(receipt, { locale: req.locale, networks: ports.networks });
  const adapter = ports.adapter(receipt.network);
  try {
    const verification = await chainCall(ports, opts, (o) =>
      adapter.verifyReceipt(receipt.receiptRef, o),
    );
    if (verification.ok) {
      return matches(receipt, verification.receipt)
        ? { status: 'verified', reason: null, receipt: view }
        : { status: 'failed', reason: 'not_confirmed', receipt: view };
    }
    return verification.reason === 'outside_rpc_retention'
      ? { status: 'unavailable', reason: null, receipt: view }
      : { status: 'failed', reason: 'not_confirmed', receipt: view };
  } catch (error) {
    if (error instanceof ReceiptChainTimeoutError || isChainAdapterError(error)) {
      return { status: 'unavailable', reason: null, receipt: view };
    }
    throw error;
  }
}
