// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Webhook signatures. Self's own verifier plugs in behind
// SelfWebhookVerifier; this HMAC verifier is the scheme used until the
// recorded deliveries pin the real one. The header carries the send time and
// one or more signatures over `<time>.<raw body>`, so a delivery replayed
// after the tolerance fails even with a valid signature, and a secret can be
// rotated by accepting both for a while.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { UnixSeconds } from '@ujira/chain-adapter';

export const SELF_SIGNATURE_HEADER = 'self-signature';

export type SignatureFailure = 'missing' | 'malformed' | 'stale' | 'mismatch';

export type SignatureCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureFailure };

/** Header names in lower case, as fetch and node both give them. */
export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

export interface SelfWebhookVerifier {
  verify(rawBody: Uint8Array, headers: WebhookHeaders, now: UnixSeconds): SignatureCheck;
}

const HEADER = /^t=(\d{1,12})((?:,v1=[0-9a-f]{64})+)$/;

export function selfSignature(secret: Uint8Array, time: bigint, rawBody: Uint8Array): string {
  return createHmac('sha256', secret).update(`${time.toString()}.`).update(rawBody).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Accepts a delivery signed by any current secret within `toleranceSeconds`
 * of now, either way. Secrets come from the secret manager, never config.
 */
export function hmacSelfWebhookVerifier(
  secrets: readonly Uint8Array[],
  toleranceSeconds: number,
): SelfWebhookVerifier {
  if (secrets.length === 0 || secrets.some((secret) => secret.length < 32)) {
    throw new RangeError('webhook secrets must be at least 32 bytes');
  }
  const tolerance = BigInt(toleranceSeconds);
  return {
    verify(rawBody, headers, now) {
      const header = headers[SELF_SIGNATURE_HEADER];
      if (header === undefined || header === '') return { ok: false, reason: 'missing' };
      const match = HEADER.exec(header);
      if (match === null) return { ok: false, reason: 'malformed' };
      const time = BigInt(match[1] ?? '0');
      const skew = time > now ? time - now : now - time;
      if (skew > tolerance) return { ok: false, reason: 'stale' };
      const given = (match[2] ?? '').split(',v1=').slice(1);
      const expected = secrets.map((secret) => selfSignature(secret, time, rawBody));
      const valid = given.some((signature) => expected.some((good) => sameHex(signature, good)));
      return valid ? { ok: true } : { ok: false, reason: 'mismatch' };
    },
  };
}
