// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { generateKeyPairSync, sign } from 'node:crypto';

import type { CallOptions, SignatureResult } from '@ujira/chain-adapter';
import { expect, test } from 'vitest';

import { splitInput } from '../test/fixtures.js';
import { documentSha256 } from './document.js';
import {
  ReceiptOptionsInvalidError,
  ReceiptSignatureInvalidError,
  ReceiptSigningAbortedError,
  ReceiptSigningTimeoutError,
} from './errors.js';
import { buildReceipt } from './model.js';
import {
  RECEIPT_SIGNING_DOMAIN,
  receiptSigningMessage,
  signReceipt,
  verifyReceiptSignature,
} from './signing.js';
import type { ReceiptSigner, ReceiptSigningFields } from './signing.js';

const receipt = buildReceipt(splitInput());
const hash = documentSha256(receipt);

interface TestKey {
  readonly publicKeyHex: string;
  sign(message: Uint8Array): SignatureResult;
}

// A throwaway key made for this test run only. Real receipt keys live
// behind the signer service and never reach this package.
function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return {
    publicKeyHex: raw.toString('hex'),
    sign: (message) => ({
      kind: 'ed25519',
      signature: new Uint8Array(sign(null, message, privateKey)),
      publicKey: new Uint8Array(raw),
    }),
  };
}

/** A signer the way the signer service is meant to behave: it builds the message itself. */
function localSigner(key: TestKey, seen: CallOptions[] = []): ReceiptSigner {
  return {
    signReceipt: (fields: ReceiptSigningFields, opts: CallOptions) => {
      seen.push(opts);
      return Promise.resolve(key.sign(receiptSigningMessage(fields)));
    },
  };
}

const key = testKey();
const base = { correlationId: 'corr-1', timeoutMs: 1_000, pinnedPublicKey: key.publicKeyHex };

test('a receipt is signed over its document hash and the signature verifies', async () => {
  const seen: CallOptions[] = [];
  const signature = await signReceipt(receipt, localSigner(key, seen), base);

  expect(signature).toMatchObject({
    algorithm: 'ed25519',
    documentSha256: hash,
    publicKey: key.publicKeyHex,
  });
  expect(signature.signature).toMatch(/^[0-9a-f]{128}$/);
  expect(Object.isFrozen(signature)).toBe(true);
  expect(verifyReceiptSignature(signature)).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.correlationId).toBe('corr-1');
  expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
});

test('the signed message is the domain followed by the document hash', () => {
  expect(new TextDecoder().decode(receiptSigningMessage({ documentSha256: hash }))).toBe(
    `${RECEIPT_SIGNING_DOMAIN}${hash}`,
  );
  expect(() => receiptSigningMessage({ documentSha256: 'A'.repeat(64) })).toThrow(
    ReceiptOptionsInvalidError,
  );
});

test('a signature over another document, or a changed one, does not verify', async () => {
  const signature = await signReceipt(receipt, localSigner(key), base);
  expect(verifyReceiptSignature({ ...signature, documentSha256: 'c'.repeat(64) })).toBe(false);
  const flipped = `${signature.signature.slice(0, -1)}${signature.signature.endsWith('0') ? '1' : '0'}`;
  expect(verifyReceiptSignature({ ...signature, signature: flipped })).toBe(false);
  expect(verifyReceiptSignature({ ...signature, publicKey: testKey().publicKeyHex })).toBe(false);
});

test('anything malformed fails verification rather than throwing', () => {
  const good = {
    algorithm: 'ed25519',
    documentSha256: hash,
    signature: '0'.repeat(128),
    publicKey: key.publicKeyHex,
  };
  expect(verifyReceiptSignature(good)).toBe(false);
  for (const bad of [
    null,
    'signature',
    { ...good, algorithm: 'rsa' },
    { ...good, signature: '0'.repeat(127) },
    { ...good, publicKey: 'Z'.repeat(64) },
    { ...good, documentSha256: '' },
    { ...good, extra: true },
  ]) {
    expect(verifyReceiptSignature(bad)).toBe(false);
  }
});

test('a signature from a key other than the pinned one is refused', async () => {
  await expect(signReceipt(receipt, localSigner(testKey()), base)).rejects.toThrow(
    new ReceiptSignatureInvalidError('the receipt was signed by a key other than the pinned one'),
  );
});

test('a signature that does not cover this receipt is refused', async () => {
  const wrongMessage: ReceiptSigner = {
    signReceipt: () => Promise.resolve(key.sign(new TextEncoder().encode('something else'))),
  };
  await expect(signReceipt(receipt, wrongMessage, base)).rejects.toThrow(
    new ReceiptSignatureInvalidError('the signature does not verify'),
  );
});

test('a malformed answer from the signer is refused', async () => {
  const good = key.sign(receiptSigningMessage({ documentSha256: hash }));
  for (const answer of [
    null,
    { ...good, kind: 'secp256k1' },
    { ...good, signature: good.signature.slice(0, 63) },
    { ...good, publicKey: Array.from(good.publicKey) },
  ]) {
    const signer = { signReceipt: () => Promise.resolve(answer) } as unknown as ReceiptSigner;
    await expect(signReceipt(receipt, signer, base)).rejects.toThrow(
      new ReceiptSignatureInvalidError('the signer returned a malformed signature'),
    );
  }
});

test('a signer that never answers times out and sees its signal abort', async () => {
  let signal: AbortSignal | undefined;
  const silent: ReceiptSigner = {
    signReceipt: (_fields, opts) => {
      signal = opts.signal;
      return new Promise<never>(() => undefined);
    },
  };
  await expect(signReceipt(receipt, silent, { ...base, timeoutMs: 20 })).rejects.toBeInstanceOf(
    ReceiptSigningTimeoutError,
  );
  expect(signal?.aborted).toBe(true);
});

test("the caller's abort stops the wait and keeps its reason", async () => {
  const controller = new AbortController();
  const silent: ReceiptSigner = {
    signReceipt: () => {
      controller.abort(new Error('shutting down'));
      return new Promise<never>(() => undefined);
    },
  };
  const error: unknown = await signReceipt(receipt, silent, {
    ...base,
    signal: controller.signal,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReceiptSigningAbortedError);
  expect((error as Error).cause).toEqual(new Error('shutting down'));
});

test('an already aborted signal never reaches the signer', async () => {
  const seen: CallOptions[] = [];
  await expect(
    signReceipt(receipt, localSigner(key, seen), { ...base, signal: AbortSignal.abort() }),
  ).rejects.toBeInstanceOf(ReceiptSigningAbortedError);
  expect(seen).toHaveLength(0);
});

test("the signer's own errors pass through unchanged", async () => {
  class SignerDown extends Error {
    readonly code = 'SIGNER_UNAVAILABLE';
  }
  const failure = new SignerDown('backend unavailable');
  const rejecting: ReceiptSigner = { signReceipt: () => Promise.reject(failure) };
  await expect(signReceipt(receipt, rejecting, base)).rejects.toBe(failure);
  const throwing: ReceiptSigner = {
    signReceipt: () => {
      throw failure;
    },
  };
  await expect(signReceipt(receipt, throwing, base)).rejects.toBe(failure);
});

test('a deadline and a pinned key are required', async () => {
  const signer = localSigner(key);
  for (const options of [
    { ...base, timeoutMs: 0 },
    { ...base, timeoutMs: 60_001 },
    { ...base, timeoutMs: 1.5 },
    { ...base, pinnedPublicKey: 'not hex' },
  ]) {
    await expect(signReceipt(receipt, signer, options)).rejects.toBeInstanceOf(
      ReceiptOptionsInvalidError,
    );
  }
});
