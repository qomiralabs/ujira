// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export type ReceiptErrorCode =
  | 'RECEIPT_INVALID'
  | 'RECEIPT_NOT_CANONICAL'
  | 'RECEIPT_PRESENTATION_INVALID'
  | 'RECEIPT_OPTIONS_INVALID'
  | 'RECEIPT_SIGNING_TIMEOUT'
  | 'RECEIPT_SIGNING_ABORTED'
  | 'RECEIPT_SIGNATURE_INVALID';

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
