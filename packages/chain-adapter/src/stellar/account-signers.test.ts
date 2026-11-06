// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for stellarMinimumSignatures (account-signers.ts): the fewest
 * signers whose weights reach the medium threshold, null when none can, at
 * least one even at threshold 0, and zero weight signers never count. Out
 * of range weights or thresholds throw InvalidInputError.
 */

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import type { StellarAccountEntry, StellarSignerKind } from './account-rules.js';
import { readStellarPrincipalSigning, stellarMinimumSignatures } from './account-signers.js';
import type { StellarLedgerKey, StellarLedgerReader } from './check-destination.js';

const signer = (key: string, weight: number) => ({ key, weight });

const PRINCIPAL = 'GBM2UM2TYRI3VYPL3IHIVLJVWL7MZCIJ5JTRTKMOZDTLQORXPG7FFRGP';
const OPTS = { correlationId: 'test' };

function account(
  masterWeight: number,
  medium: number,
  signers: readonly { kind?: StellarSignerKind; key: string; weight: number }[] = [],
): StellarAccountEntry {
  return {
    accountId: PRINCIPAL,
    masterWeight,
    thresholds: { low: 1, medium, high: 3 },
    signers: signers.map((s) => ({ kind: s.kind ?? 'ed25519', key: s.key, weight: s.weight })),
  };
}

function readerOf(entry: StellarAccountEntry | null): StellarLedgerReader & {
  asked: (readonly StellarLedgerKey[])[];
} {
  const asked: (readonly StellarLedgerKey[])[] = [];
  return {
    asked,
    getLedgerEntries(_network, keys) {
      asked.push(keys);
      return Promise.resolve([entry === null ? null : { kind: 'account', ...entry }]);
    },
  };
}

describe('readStellarPrincipalSigning', () => {
  const read = (entry: StellarAccountEntry | null) =>
    readStellarPrincipalSigning(readerOf(entry), 'stellar:testnet', PRINCIPAL, OPTS);

  it('reads a 2 of 3 account as a multisig of two', async () => {
    const two = account(1, 2, [signer('GA', 1), signer('GB', 1)]);
    await expect(read(two)).resolves.toEqual({ kind: 'multisig', minSignatures: 2 });
  });

  it('reads an account whose master key alone meets the threshold as one key', async () => {
    const master = account(2, 2, [signer('GA', 1), signer('GB', 1)]);
    await expect(read(master)).resolves.toEqual({ kind: 'single_key' });
    await expect(read(account(1, 0))).resolves.toEqual({ kind: 'single_key' });
  });

  it('counts a signer of any kind, since each can authorize on its own', async () => {
    const hashX = account(0, 2, [{ kind: 'hash_x', key: 'X', weight: 2 }, signer('GA', 1)]);
    await expect(read(hashX)).resolves.toEqual({ kind: 'single_key' });
  });

  it('reads a missing account, or one nothing can authorize for, as unverified', async () => {
    await expect(read(null)).resolves.toEqual({ kind: 'unverified' });
    await expect(read(account(0, 2, [signer('GA', 1)]))).resolves.toEqual({ kind: 'unverified' });
  });

  it('asks for the principal account on the ledger', async () => {
    const reader = readerOf(account(1, 0));
    await readStellarPrincipalSigning(reader, 'stellar:testnet', PRINCIPAL, OPTS);
    expect(reader.asked).toEqual([[{ kind: 'account', accountId: PRINCIPAL }]]);
  });

  it('refuses a contract address, which has no thresholds to read', async () => {
    const contract = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
    const reader = readerOf(null);
    await expect(
      readStellarPrincipalSigning(reader, 'stellar:testnet', contract, OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(reader.asked).toEqual([]);
  });
});

describe('stellarMinimumSignatures', () => {
  it('needs two of three when each signer holds one of a threshold of two', () => {
    expect(
      stellarMinimumSignatures({
        mediumThreshold: 2,
        signers: [signer('master', 0), signer('a', 1), signer('b', 1), signer('c', 1)],
      }),
    ).toBe(2);
  });

  it('needs one when the master key alone meets the threshold', () => {
    expect(
      stellarMinimumSignatures({
        mediumThreshold: 2,
        signers: [signer('master', 2), signer('a', 1), signer('b', 1)],
      }),
    ).toBe(1);
  });

  it('needs one for a default account', () => {
    expect(stellarMinimumSignatures({ mediumThreshold: 0, signers: [signer('master', 1)] })).toBe(
      1,
    );
  });

  it('counts the heaviest signers first', () => {
    expect(
      stellarMinimumSignatures({
        mediumThreshold: 10,
        signers: [signer('a', 1), signer('b', 9), signer('c', 1), signer('d', 2)],
      }),
    ).toBe(2);
  });

  it('is null when no set of signers reaches the threshold', () => {
    expect(
      stellarMinimumSignatures({ mediumThreshold: 5, signers: [signer('a', 2), signer('b', 2)] }),
    ).toBeNull();
    expect(stellarMinimumSignatures({ mediumThreshold: 1, signers: [signer('m', 0)] })).toBeNull();
  });

  it.each([
    { mediumThreshold: 256, signers: [signer('a', 1)] },
    { mediumThreshold: 1, signers: [signer('a', -1)] },
    { mediumThreshold: 1.5, signers: [signer('a', 1)] },
  ])('refuses out of range values', (account) => {
    expect(() => stellarMinimumSignatures(account)).toThrow(InvalidInputError);
  });
});
