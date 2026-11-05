// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the Stellar signer and receivability rules
 * (account-rules.ts), over decoded ledger entries.
 *
 * Signers: the account's own key counts when its master weight is above
 * zero. Another key counts only as an ed25519 signer with weight above zero
 * and at least the low threshold. Pre-authorized transaction, hash-x and
 * signed payload signers never count.
 *
 * Receivability, first failure wins: ACCOUNT_NOT_FOUND, DESTINATION_IS_ISSUER,
 * NO_TRUSTLINE, TRUSTLINE_NOT_AUTHORIZED (authorized to maintain liabilities
 * only is not enough), TRUSTLINE_LIMIT when limit - balance - buying
 * liabilities is below the amount.
 */

import { describe, expect, it } from 'vitest';

import { encodeAccountAddress } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import {
  TRUSTLINE_AUTHORIZED,
  TRUSTLINE_AUTHORIZED_TO_MAINTAIN_LIABILITIES,
  isCurrentSigner,
  receivability,
} from './account-rules.js';
import type { StellarAccountEntry, StellarTrustlineEntry } from './account-rules.js';

const G = (fill: number) => encodeAccountAddress(new Uint8Array(32).fill(fill));
const ACCOUNT = G(1);
const ADDED = G(2);
const ISSUER = G(3);
const ASSET = { code: 'USDC', issuer: ISSUER };

function account(overrides: Partial<StellarAccountEntry> = {}): StellarAccountEntry {
  return {
    accountId: ACCOUNT,
    masterWeight: 1,
    thresholds: { low: 1, medium: 2, high: 3 },
    signers: [],
    ...overrides,
  };
}

function trustline(overrides: Partial<StellarTrustlineEntry> = {}): StellarTrustlineEntry {
  return {
    accountId: ACCOUNT,
    asset: ASSET,
    balance: 0n,
    limit: 1_000_0000000n,
    buyingLiabilities: 0n,
    flags: TRUSTLINE_AUTHORIZED,
    ...overrides,
  };
}

describe('isCurrentSigner', () => {
  it('counts the master key only with a weight above zero', () => {
    expect(isCurrentSigner(account({ masterWeight: 1 }), ACCOUNT)).toBe(true);
    expect(isCurrentSigner(account({ masterWeight: 0 }), ACCOUNT)).toBe(false);
  });

  it('counts an added signer from the low threshold', () => {
    const withAdded = (weight: number) =>
      account({
        thresholds: { low: 5, medium: 5, high: 5 },
        signers: [{ kind: 'ed25519', key: ADDED, weight }],
      });
    expect(isCurrentSigner(withAdded(5), ADDED)).toBe(true);
    expect(isCurrentSigner(withAdded(6), ADDED)).toBe(true);
    expect(isCurrentSigner(withAdded(4), ADDED)).toBe(false);
    // A low threshold of zero still needs a weight above zero.
    const zeroLow = account({
      thresholds: { low: 0, medium: 0, high: 0 },
      signers: [{ kind: 'ed25519', key: ADDED, weight: 0 }],
    });
    expect(isCurrentSigner(zeroLow, ADDED)).toBe(false);
  });

  it('refuses a key that is not a signer', () => {
    expect(isCurrentSigner(account(), ADDED)).toBe(false);
  });

  it('ignores pre-authorized transaction, hash-x and signed payload signers', () => {
    for (const kind of ['pre_auth_tx', 'hash_x', 'signed_payload'] as const) {
      const entry = account({ signers: [{ kind, key: ADDED, weight: 10 }] });
      expect(isCurrentSigner(entry, ADDED)).toBe(false);
    }
  });
});

describe('receivability', () => {
  it('refuses a missing account', () => {
    expect(receivability(ACCOUNT, null, null, ASSET)).toEqual({
      receivable: false,
      reason: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('refuses the issuer', () => {
    expect(receivability(ISSUER, account({ accountId: ISSUER }), null, ASSET)).toEqual({
      receivable: false,
      reason: 'DESTINATION_IS_ISSUER',
    });
  });

  it('needs a trustline that is fully authorized', () => {
    expect(receivability(ACCOUNT, account(), null, ASSET)).toEqual({
      receivable: false,
      reason: 'NO_TRUSTLINE',
    });
    for (const flags of [0, TRUSTLINE_AUTHORIZED_TO_MAINTAIN_LIABILITIES]) {
      expect(receivability(ACCOUNT, account(), trustline({ flags }), ASSET)).toEqual({
        receivable: false,
        reason: 'TRUSTLINE_NOT_AUTHORIZED',
      });
    }
    expect(receivability(ACCOUNT, account(), trustline(), ASSET)).toEqual({ receivable: true });
  });

  it('checks the room under the limit at the boundary', () => {
    const line = trustline({ limit: 1000n, balance: 600n, buyingLiabilities: 100n });
    expect(receivability(ACCOUNT, account(), line, ASSET, 300n)).toEqual({ receivable: true });
    expect(receivability(ACCOUNT, account(), line, ASSET, 301n)).toEqual({
      receivable: false,
      reason: 'TRUSTLINE_LIMIT',
    });
    expect(() => receivability(ACCOUNT, account(), line, ASSET, 0n)).toThrow(InvalidInputError);
  });
});
