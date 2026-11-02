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
import { stellarMinimumSignatures } from './account-signers.js';

const signer = (key: string, weight: number) => ({ key, weight });

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
