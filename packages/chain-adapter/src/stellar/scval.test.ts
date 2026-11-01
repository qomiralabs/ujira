// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Address, Keypair, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { InternalError, InvalidInputError } from '../errors.js';
import type { Bytes32 } from '../types.js';
import {
  address,
  asAddress,
  asBool,
  asBytes,
  asBytes32,
  asI128,
  asOption,
  asU32,
  asU64,
  asVariant,
  asVec,
  bytes,
  bytes32,
  destination,
  field,
  fieldsOf,
  i128,
  option,
  struct,
  sym,
  u32,
  u64,
  unit,
  vec,
} from './scval.js';
import { configViewOf, limitsOf, stateOf } from './views.js';

const G = Keypair.random().publicKey();
const C = Address.contract(Buffer.alloc(32, 1)).toString();

describe('contract value encoding', () => {
  it('round trips integers at their bounds', () => {
    for (const n of [0n, 1n, -1n, (1n << 127n) - 1n, -(1n << 127n), 123_456_789_012_345_678_901n]) {
      expect(asI128(i128('n', n))).toBe(n);
    }
    expect(asU64(u64('n', (1n << 64n) - 1n))).toBe((1n << 64n) - 1n);
    expect(asU32(u32('n', 4_294_967_295))).toBe(4_294_967_295);
  });

  it('refuses values outside their domain, naming the field only', () => {
    const bad: (() => unknown)[] = [
      () => i128('amount', 1n << 127n),
      () => i128('amount', 1 as unknown as bigint),
      () => u64('at', -1n),
      () => u64('at', 1n << 64n),
      () => u32('n', 1.5),
      () => u32('n', 4_294_967_296),
      () => bytes('key', 'abc' as unknown as Uint8Array),
      () => bytes32('ref', '0xAB' as Bytes32),
      () => bytes32('ref', `0x${'G'.repeat(64)}` as Bytes32),
      () => address('who', `M${G.slice(1)}`),
      () => address('who', 'GBAD'),
      () => address('who', 7 as unknown as string),
      () => destination('dest', { address: { network: 'stellar:testnet', value: C }, tag: 1n }),
      () => destination('dest', { address: { network: 'stellar:testnet', value: G }, tag: 1n << 64n }),
    ];
    for (const f of bad) {
      expect(f).toThrow(InvalidInputError);
    }
    try {
      i128('limits.totalBudget', 1n << 127n);
    } catch (error) {
      expect((error as InvalidInputError).issues).toEqual(['limits.totalBudget (invalid)']);
    }
  });

  it('writes a tagged destination as a muxed address and a plain one as its base', () => {
    const tagged = destination('d', { address: { network: 'stellar:testnet', value: G }, tag: 9n });
    expect(tagged.type === 'scvAddress' && tagged.address.type).toBe('scAddressTypeMuxedAccount');
    const plain = destination('d', { address: { network: 'stellar:testnet', value: G }, tag: null });
    expect(asAddress(plain)).toBe(G);
  });

  it('sorts struct fields and writes options, units and bytes', () => {
    const s = struct({ zeta: u32('z', 1), alpha: u32('a', 2), mid: option(null) });
    expect([...fieldsOf(s).keys()]).toEqual(['alpha', 'mid', 'zeta']);
    expect(asOption(field(fieldsOf(s), 'mid'))).toBeNull();
    expect(asOption(u32('x', 1))).not.toBeNull();
    expect(asVariant(unit('Fixed'))).toEqual({ name: 'Fixed', payload: [] });
    expect(asBytes(bytes('b', new Uint8Array([1, 2])))).toEqual(new Uint8Array([1, 2]));
    expect(asBytes32(bytes32('r', `0x${'0f'.repeat(32)}` as Bytes32))).toBe(`0x${'0f'.repeat(32)}`);
    expect(asVec(vec([sym('a')]))).toHaveLength(1);
    expect(asVec(xdr.ScVal.scvVec(null))).toEqual([]);
    expect([...fieldsOf(xdr.ScVal.scvMap(null)).keys()]).toEqual([]);
    expect(asBool(xdr.ScVal.scvBool(true))).toBe(true);
    expect(asAddress(address('c', C))).toBe(C);
  });

  it('refuses answers in an unexpected shape as internal errors', () => {
    const wrong = xdr.ScVal.scvVoid();
    const muxed = destination('d', { address: { network: 'stellar:testnet', value: G }, tag: 1n });
    const bad: (() => unknown)[] = [
      () => fieldsOf(wrong),
      () => fieldsOf(xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: u32('k', 1), val: wrong })])),
      () => field(new Map(), 'missing'),
      () => asU32(wrong),
      () => asU64(wrong),
      () => asI128(wrong),
      () => asBool(wrong),
      () => asBytes(wrong),
      () => asBytes32(bytes('b', new Uint8Array(31))),
      () => asAddress(wrong),
      () => asAddress(muxed),
      () => asVec(wrong),
      () => asVariant(vec([u32('x', 1)])),
      () => asVariant(vec([])),
    ];
    for (const f of bad) expect(f).toThrow(InternalError);
  });
});

describe('mandate views', () => {
  const amount = (n: bigint) => i128('a', n);
  const limits = struct({
    total_budget: amount(10n),
    per_payment_cap: amount(5n),
    per_recipient_daily_cap: amount(6n),
    approval_threshold: amount(0n),
    payout_ttl_seconds: u64('t', 3600n),
    expires_at: u64('e', 1_900_000_000n),
  });
  const config = (mode: number, overrides: Record<string, xdr.ScVal> = {}) =>
    struct({
      principal: address('p', G),
      asset: address('a', C),
      recipient_mode: u32('m', mode),
      tenant_ref: bytes32('t', `0x${'11'.repeat(32)}` as Bytes32),
      agents: vec([address('x', G)]),
      approvers: vec([]),
      approvals_required: u32('n', 0),
      guardians: vec([]),
      executors: vec([]),
      recovery: vec([]),
      recovery_threshold: u32('n', 0),
      limits,
      attester: bytes('k', new Uint8Array(32).fill(3)),
      country_policy_hash: bytes32('h', `0x${'22'.repeat(32)}` as Bytes32),
      max_fee_bps: u32('f', 10),
      fee_address: address('f', G),
      proposed_principal: address('pp', C),
      recovery_epoch: u32('r', 0),
      agent_epoch: u32('a', 0),
      ...overrides,
    });
  const ctx = { network: 'stellar:testnet' as const, factory: C, policyEpoch: 2 };

  it('reads the config with an attester and a proposed principal', () => {
    const view = configViewOf(config(2), ctx);
    expect(view.recipientMode).toBe('attested');
    expect(view.attester).toEqual(new Uint8Array(32).fill(3));
    expect(view.proposedPrincipal?.value).toBe(C);
    expect(view.policyEpoch).toBe(2);
    expect(view.limits.payoutTtlSeconds).toBe(3600);
  });

  it('refuses an unknown recipient mode and a number too large to hold', () => {
    expect(() => configViewOf(config(9), ctx)).toThrow(InternalError);
    const huge = struct({ ...Object.fromEntries(fieldsOf(limits)), payout_ttl_seconds: u64('t', 1n << 60n) });
    expect(() => limitsOf(huge)).toThrow(InternalError);
    const state = struct({
      spent: amount(0n),
      pending: amount(0n),
      committed: amount(0n),
      balance: amount(0n),
      free: amount(0n),
      paused: xdr.ScVal.scvBool(false),
      revoked: xdr.ScVal.scvBool(false),
      expired: xdr.ScVal.scvBool(false),
      policy_epoch: u64('e', 1n << 60n),
    });
    expect(() => stateOf(state)).toThrow(InternalError);
  });
});
