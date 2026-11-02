// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes } from 'node:crypto';

import type { UnixSeconds } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { TEST_NOW } from '../testing/index.js';

import { SELF_SIGNATURE_HEADER, hmacSelfWebhookVerifier, selfSignature } from './signature.js';

const body = new TextEncoder().encode('{"hello":"self"}');

function header(secret: Uint8Array, time: bigint, extra: readonly string[] = []): string {
  return [`t=${time.toString()}`, ...extra, `v1=${selfSignature(secret, time, body)}`].join(',');
}

describe('hmacSelfWebhookVerifier', () => {
  const current = randomBytes(32);
  const previous = randomBytes(32);
  const verifier = hmacSelfWebhookVerifier([current, previous], 300);

  it('accepts either secret during a rotation, and a header carrying several signatures', () => {
    expect(
      verifier.verify(body, { [SELF_SIGNATURE_HEADER]: header(current, TEST_NOW) }, TEST_NOW),
    ).toEqual({ ok: true });
    expect(
      verifier.verify(body, { [SELF_SIGNATURE_HEADER]: header(previous, TEST_NOW) }, TEST_NOW),
    ).toEqual({ ok: true });
    const other = `v1=${selfSignature(randomBytes(32), TEST_NOW, body)}`;
    expect(
      verifier.verify(
        body,
        { [SELF_SIGNATURE_HEADER]: header(current, TEST_NOW, [other]) },
        TEST_NOW,
      ),
    ).toEqual({ ok: true });
  });

  it('names why a delivery is refused', () => {
    const cases: [string | undefined, UnixSeconds, string][] = [
      [undefined, TEST_NOW, 'missing'],
      ['', TEST_NOW, 'missing'],
      ['t=1,v1=nothex', TEST_NOW, 'malformed'],
      [`v1=${selfSignature(current, TEST_NOW, body)}`, TEST_NOW, 'malformed'],
      [header(current, TEST_NOW - 301n), TEST_NOW, 'stale'],
      [header(current, TEST_NOW + 301n), TEST_NOW, 'stale'],
      [header(randomBytes(32), TEST_NOW), TEST_NOW, 'mismatch'],
    ];
    for (const [value, now, reason] of cases) {
      expect(verifier.verify(body, { [SELF_SIGNATURE_HEADER]: value }, now)).toEqual({
        ok: false,
        reason,
      });
    }
    // The signature covers the time, so moving the time breaks it.
    const signed = selfSignature(current, TEST_NOW, body);
    expect(
      verifier.verify(
        body,
        { [SELF_SIGNATURE_HEADER]: `t=${(TEST_NOW + 1n).toString()},v1=${signed}` },
        TEST_NOW,
      ),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses no secrets or a short one', () => {
    expect(() => hmacSelfWebhookVerifier([], 300)).toThrow(RangeError);
    expect(() => hmacSelfWebhookVerifier([randomBytes(16)], 300)).toThrow(RangeError);
  });
});
