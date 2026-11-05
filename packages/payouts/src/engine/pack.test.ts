// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { packExecutes, packRequests, transfersOf, type Transfers } from './pack.js';

const items = (count: number, legs: number, fee: bigint): readonly Transfers[] =>
  Array.from({ length: count }, () => ({ legs, fee }));

describe('packing', () => {
  it('25 requests become batches of 10, 10 and 5', () => {
    expect(packRequests(items(25, 1, 0n)).map((pack) => pack.length)).toEqual([10, 10, 5]);
  });

  it('no requests make no batches', () => {
    expect(packRequests([])).toEqual([]);
    expect(packExecutes([], (item: Transfers) => item)).toEqual([]);
  });

  it('2-leg payouts pack 9 per batch', () => {
    const packs = packExecutes(items(20, 2, 0n), (item) => item);
    expect(packs.map((pack) => pack.length)).toEqual([9, 9, 2]);
  });

  it('a fee above zero is a transfer of its own', () => {
    expect(transfersOf({ legs: 2, fee: 1n })).toBe(3);
    expect(transfersOf({ legs: 2, fee: 0n })).toBe(2);
    const packs = packExecutes(items(7, 2, 1n), (item) => item);
    expect(packs.map((pack) => pack.length)).toEqual([6, 1]);
  });

  it('single leg payouts with no fee stop at 10 items, before any transfer limit', () => {
    const packs = packExecutes(items(11, 1, 0n), (item) => item);
    expect(packs.map((pack) => pack.length)).toEqual([10, 1]);
  });

  it('keeps the order it was given', () => {
    const numbered = Array.from({ length: 25 }, (_, index) => index);
    const packs = packExecutes(numbered, () => ({ legs: 2, fee: 1n }));
    expect(packs.flat()).toEqual(numbered);
    expect(packRequests(numbered).flat()).toEqual(numbered);
  });
});
