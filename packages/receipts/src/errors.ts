// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export type ReceiptErrorCode =
  | 'RECEIPT_INVALID'
  | 'RECEIPT_NOT_CANONICAL'
  | 'RECEIPT_PRESENTATION_INVALID'
  | 'RECEIPT_OPTIONS_INVALID'
  | 'RECEIPT_SIGNING_TIMEOUT'
  | 'RECEIPT_SIGNING_ABORTED'
  | 'RECEIPT_SIGNATURE_INVALID'
  | 'RECEIPT_NOT_PAID'
  | 'RECEIPT_NOT_ISSUED'
  | 'RECEIPT_TENANT_MISMATCH'
  | 'RECEIPT_UNVERIFIED'
  | 'RECEIPT_CHAIN_TIMEOUT'
  | 'RECEIPT_CHAIN_ABORTED';

/**
 * Base class for every receipt failure. Callers branch on `code`, which
 * stays stable across releases, rather than on message text. Messages and
 * issues name the field that was wrong and never its value: a receipt holds
 * destinations and names that have no place in a log line.
 */
export abstract class ReceiptError extends Error {
  abstract readonly code: ReceiptErrorCode;
}

// Each subclass spells its own name out so minified builds keep readable names.

/** The receipt breaks the model's rules. `issues` lists the paths that failed. */
export class ReceiptInvalidError extends ReceiptError {
  override readonly name = 'ReceiptInvalidError';
  readonly code = 'RECEIPT_INVALID';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('the receipt is not valid');
    this.issues = Object.freeze([...issues]);
  }
}

/** A value that has no single canonical JSON form, such as a float or a Date. */
export class ReceiptNotCanonicalError extends ReceiptError {
  override readonly name = 'ReceiptNotCanonicalError';
  readonly code = 'RECEIPT_NOT_CANONICAL';
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`not canonical at ${path}: ${reason}`);
    this.path = path;
  }
}

/** The network presentation from configuration gave a name or link that cannot be shown. */
export class ReceiptPresentationInvalidError extends ReceiptError {
  override readonly name = 'ReceiptPresentationInvalidError';
  readonly code = 'RECEIPT_PRESENTATION_INVALID';
}

/** A caller passed options the operation cannot run with, such as a missing deadline. */
export class ReceiptOptionsInvalidError extends ReceiptError {
  override readonly name = 'ReceiptOptionsInvalidError';
  readonly code = 'RECEIPT_OPTIONS_INVALID';
}

/** The signer did not answer within the deadline. Safe to retry: nothing was stored. */
export class ReceiptSigningTimeoutError extends ReceiptError {
  override readonly name = 'ReceiptSigningTimeoutError';
  readonly code = 'RECEIPT_SIGNING_TIMEOUT';
}

/** The caller's signal was aborted before the signer answered. */
export class ReceiptSigningAbortedError extends ReceiptError {
  override readonly name = 'ReceiptSigningAbortedError';
  readonly code = 'RECEIPT_SIGNING_ABORTED';
}

/** A signature that does not verify, or was made by a key other than the pinned one. */
export class ReceiptSignatureInvalidError extends ReceiptError {
  override readonly name = 'ReceiptSignatureInvalidError';
  readonly code = 'RECEIPT_SIGNATURE_INVALID';
}

/** The payout has not reached paid, so there is nothing to issue yet. */
export class ReceiptNotPaidError extends ReceiptError {
  override readonly name = 'ReceiptNotPaidError';
  readonly code = 'RECEIPT_NOT_PAID';
}

/** A correction named a revision that has not been issued. */
export class ReceiptNotIssuedError extends ReceiptError {
  override readonly name = 'ReceiptNotIssuedError';
  readonly code = 'RECEIPT_NOT_ISSUED';
}

/** A port answered for another tenant. Always a bug, and never reaches a receipt. */
export class ReceiptTenantMismatchError extends ReceiptError {
  override readonly name = 'ReceiptTenantMismatchError';
  readonly code = 'RECEIPT_TENANT_MISMATCH';
}

/** The issue job cannot finish yet, so the queue's bounded retries apply. */
export class ReceiptUnverifiedError extends ReceiptError {
  override readonly name = 'ReceiptUnverifiedError';
  readonly code = 'RECEIPT_UNVERIFIED';
}

/** The chain did not answer within the deadline. Nothing was stored. */
export class ReceiptChainTimeoutError extends ReceiptError {
  override readonly name = 'ReceiptChainTimeoutError';
  readonly code = 'RECEIPT_CHAIN_TIMEOUT';
}

/** The caller's signal was aborted before the chain answered. Nothing was stored. */
export class ReceiptChainAbortedError extends ReceiptError {
  override readonly name = 'ReceiptChainAbortedError';
  readonly code = 'RECEIPT_CHAIN_ABORTED';
}
