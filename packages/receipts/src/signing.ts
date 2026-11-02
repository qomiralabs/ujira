// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A receipt is signed over its document hash so anyone holding the document
// and UJIRA's receipt key can tell it came from UJIRA unchanged. The key
// lives behind the signer service, never here: this package only lays out
// the message, asks the signer, and checks the answer against the key that
// configuration pins before anything is stored.

import { createPublicKey, verify } from 'node:crypto';

import type { CallOptions, SignatureResult } from '@ujira/chain-adapter';
import { z } from 'zod';

import { documentSha256 } from './document.js';
import {
  ReceiptOptionsInvalidError,
  ReceiptSignatureInvalidError,
  ReceiptSigningAbortedError,
  ReceiptSigningTimeoutError,
} from './errors.js';
import type { Receipt } from './model.js';

/**
 * Prefixed to every signed message so a receipt signature can never be
 * replayed as any other kind of signature the same key might make.
 */
export const RECEIPT_SIGNING_DOMAIN = 'ujira:receipt:v1:';

/** The longest a caller may wait for the signer. */
export const MAX_SIGNING_TIMEOUT_MS = 60_000;

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

/** What a receipt signature covers. The signer builds the bytes itself from these. */
export interface ReceiptSigningFields {
  readonly documentSha256: string;
}

/**
 * The port the signer service implements for receipts. An implementation
 * builds the message with receiptSigningMessage, signs exactly those bytes
 * with the receipt key, and fails with the signer's own typed errors.
 */
export interface ReceiptSigner {
  signReceipt(fields: ReceiptSigningFields, opts: CallOptions): Promise<SignatureResult>;
}

/** A stored signature: hex throughout, so it sits next to the document as plain text. */
export interface ReceiptSignature {
  readonly algorithm: 'ed25519';
  readonly documentSha256: string;
  readonly signature: string;
  readonly publicKey: string;
}

export interface SignReceiptOptions extends CallOptions {
  /** Deadline for the signer, in milliseconds. */
  readonly timeoutMs: number;
  /** The receipt key configuration pins, as 64 hex characters. Any other key is refused. */
  readonly pinnedPublicKey: string;
}

/** The exact bytes a receipt signature covers. */
export function receiptSigningMessage(fields: ReceiptSigningFields): Uint8Array {
  if (!HEX_64.test(fields.documentSha256)) {
    throw new ReceiptOptionsInvalidError('documentSha256 must be 64 lowercase hex characters');
  }
  return new TextEncoder().encode(`${RECEIPT_SIGNING_DOMAIN}${fields.documentSha256}`);
}

// DER header of an Ed25519 SubjectPublicKeyInfo, ahead of the 32 key bytes.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, message, key, signature);
}

const SignatureSchema = z.strictObject({
  algorithm: z.literal('ed25519'),
  documentSha256: z.string().regex(HEX_64),
  signature: z.string().regex(HEX_128),
  publicKey: z.string().regex(HEX_64),
});

/**
 * Whether `signature` is a valid ed25519 signature by its public key over
 * the receipt message for its document hash. Anything malformed is false.
 * Callers still compare the public key with the one they trust.
 */
export function verifyReceiptSignature(signature: unknown): boolean {
  const parsed = SignatureSchema.safeParse(signature);
  if (!parsed.success) return false;
  const { documentSha256: hash, signature: sig, publicKey } = parsed.data;
  return verifyEd25519(
    receiptSigningMessage({ documentSha256: hash }),
    Buffer.from(sig, 'hex'),
    Buffer.from(publicKey, 'hex'),
  );
}

const OptionsSchema = z.object({
  timeoutMs: z.number().int().min(1).max(MAX_SIGNING_TIMEOUT_MS),
  pinnedPublicKey: z.string().regex(HEX_64),
});

// The signer's answer is checked rather than trusted: the port promises raw
// ed25519 bytes, and a backend that broke that promise must not get a
// signature stored.
const ResultSchema = z.object({
  kind: z.literal('ed25519'),
  signature: z.instanceof(Uint8Array).refine((bytes) => bytes.length === 64),
  publicKey: z.instanceof(Uint8Array).refine((bytes) => bytes.length === 32),
});

/**
 * Runs `call` with a signal that fires at the deadline or when the caller
 * aborts, and stops waiting at that moment even if the signer ignores the
 * signal. A late answer or failure from the signer is dropped by the race.
 */
async function withDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer === undefined ? timeout : AbortSignal.any([outer, timeout]);
  const reason = (): Error =>
    timeout.aborted
      ? new ReceiptSigningTimeoutError('the signer did not answer in time')
      : new ReceiptSigningAbortedError('signing was aborted by the caller', {
          cause: signal.reason,
        });
  if (signal.aborted) throw reason();
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(reason());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => call(signal)), stopped]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Signs a receipt through the signer port and returns the signature to
 * store with it. Throws ReceiptSigningTimeoutError at the deadline,
 * ReceiptSigningAbortedError when the caller aborts, and
 * ReceiptSignatureInvalidError when the answer is malformed, made by a key
 * other than the pinned one, or does not verify. The signer's own errors
 * pass through unchanged so callers can apply its retry rules.
 */
export async function signReceipt(
  receipt: Receipt,
  signer: ReceiptSigner,
  options: SignReceiptOptions,
): Promise<ReceiptSignature> {
  const checked = OptionsSchema.safeParse(options);
  if (!checked.success) {
    throw new ReceiptOptionsInvalidError(
      `invalid signing options: ${checked.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const { timeoutMs, pinnedPublicKey } = checked.data;
  const hash = documentSha256(receipt);
  const fields: ReceiptSigningFields = Object.freeze({ documentSha256: hash });
  const answer: unknown = await withDeadline(
    (signal) => signer.signReceipt(fields, { correlationId: options.correlationId, signal }),
    timeoutMs,
    options.signal,
  );
  const result = ResultSchema.safeParse(answer);
  if (!result.success) {
    throw new ReceiptSignatureInvalidError('the signer returned a malformed signature');
  }
  const publicKey = Buffer.from(result.data.publicKey).toString('hex');
  if (publicKey !== pinnedPublicKey) {
    throw new ReceiptSignatureInvalidError(
      'the receipt was signed by a key other than the pinned one',
    );
  }
  if (!verifyEd25519(receiptSigningMessage(fields), result.data.signature, result.data.publicKey)) {
    throw new ReceiptSignatureInvalidError('the signature does not verify');
  }
  return Object.freeze({
    algorithm: 'ed25519',
    documentSha256: hash,
    signature: Buffer.from(result.data.signature).toString('hex'),
    publicKey,
  });
}
