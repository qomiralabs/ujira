// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which ledger entries keep a mandate usable: its instance, its code, the
// persistent entries it reads on every payout, and the asset contract's
// Balance entry that holds its money. Payout records and tombstones follow
// their own lifetime and are never in this set.

import { xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import { STRKEY_VERSION, encodeStrkey } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import type { Bytes32 } from '../types.js';

import { FIXTURE_USDC, loadReadFixture } from './test-rpc.js';
import { keepAliveKeys } from './ttl-keys.js';
import type { KeepAliveTarget } from './ttl-keys.js';

const contractId = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const contract = (fill: number): string => encodeStrkey(STRKEY_VERSION.contract, contractId(fill));
const account = (fill: number): string => encodeStrkey(STRKEY_VERSION.account, contractId(fill));

const MANDATE = contract(0x11);
const USDC_SAC = contract(0x22);
const WASM_HASH = '33'.repeat(32);
const REF_A = `0x${'44'.repeat(32)}` as Bytes32;
const REF_B = `0x${'55'.repeat(32)}` as Bytes32;

const TARGET: KeepAliveTarget = {
  mandate: MANDATE,
  asset: USDC_SAC,
  wasmHash: WASM_HASH,
  allowed: [
    { recipientRef: REF_A, address: account(0x66), tag: null },
    { recipientRef: REF_A, address: account(0x66), tag: 0n },
    { recipientRef: REF_B, address: contract(0x77), tag: 9n },
  ],
  daily: [REF_A, REF_B],
};

const u32 = (n: number): string => n.toString(16).padStart(8, '0');
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function footprintOf(text: string): {
  readonly readOnly: xdr.LedgerKey[];
  readonly readWrite: xdr.LedgerKey[];
} {
  const footprint = xdr.SorobanTransactionData.fromXDR(text, 'base64').resources().footprint();
  return { readOnly: footprint.readOnly(), readWrite: footprint.readWrite() };
}

describe('ttl.keys.test.ts', () => {
  it('builds the asset contract Balance key for a mandate', () => {
    // LedgerKey CONTRACT_DATA (6) { contract: SC_ADDRESS_TYPE_CONTRACT (1)
    // of the asset contract, key: SCV_VEC (16) present (1) of two items:
    // SCV_SYMBOL (15) "Balance", SCV_ADDRESS (18) contract (1) mandate,
    // durability: PERSISTENT (1) }, written out from the XDR definitions so
    // the expectation does not come from the code under test.
    const expected = [
      u32(6),
      u32(1),
      hex(contractId(0x22)),
      u32(16),
      u32(1),
      u32(2),
      u32(15),
      u32(7),
      Buffer.from('Balance\0', 'latin1').toString('hex'),
      u32(18),
      u32(1),
      hex(contractId(0x11)),
      u32(1),
    ].join('');
    const balance = keepAliveKeys(TARGET).find((key) => key.kind === 'balance');
    expect(balance).toBeDefined();
    expect(Buffer.from(balance?.xdr ?? '', 'base64').toString('hex')).toBe(expected);
    // The same shape as a key the chain itself gave: testnet's simulation of a
    // mandate's state lists the asset contract's Balance entry in its footprint.
    const fixture = loadReadFixture();
    const captured = fixture.calls.flatMap((call) => {
      const text = call.result['transactionData'];
      if (typeof text !== 'string') return [];
      const { readOnly, readWrite } = footprintOf(text);
      return [...readOnly, ...readWrite]
        .filter((k) => k.switch().name === 'contractData')
        .filter((k) => k.contractData().key().switch().name === 'scvVec')
        .filter((k) => k.contractData().key().vec()?.[0]?.sym().toString() === 'Balance')
        .map((k) => k.toXDR('base64'));
    });
    expect(captured.length).toBeGreaterThan(0);
    const ours = keepAliveKeys({
      mandate: fixture.mandate,
      asset: FIXTURE_USDC,
      wasmHash: WASM_HASH,
      allowed: [],
      daily: [],
    }).find((key) => key.kind === 'balance');
    expect(ours?.xdr).toBe(captured[0]);
  });

  it('builds the instance and the code keys', () => {
    const keys = keepAliveKeys(TARGET);
    const instance = xdr.LedgerKey.fromXDR(keys[0]?.xdr ?? '', 'base64');
    expect(keys[0]?.kind).toBe('instance');
    expect(instance.contractData().key().switch().name).toBe('scvLedgerKeyContractInstance');
    expect(instance.contractData().durability().name).toBe('persistent');
    expect(hex(instance.contractData().contract().contractId() as unknown as Uint8Array)).toBe(
      hex(contractId(0x11)),
    );
    const code = xdr.LedgerKey.fromXDR(keys[1]?.xdr ?? '', 'base64');
    expect(keys[1]?.kind).toBe('code');
    expect(code.contractCode().hash().toString('hex')).toBe(WASM_HASH);
  });

  it('keys the allowlist and day usage entries as the contract stores them', () => {
    const keys = keepAliveKeys(TARGET);
    const allowed = keys.filter((key) => key.kind === 'allowed');
    expect(allowed).toHaveLength(3);
    const parts = allowed.map(
      (key) => xdr.LedgerKey.fromXDR(key.xdr, 'base64').contractData().key().vec() ?? [],
    );
    for (const vec of parts) expect(vec[0]?.sym().toString()).toBe('Allowed');
    expect(parts.map((vec) => `0x${vec[1]?.bytes().toString('hex') ?? ''}`)).toEqual([
      REF_A,
      REF_A,
      REF_B,
    ]);
    expect(parts[2]?.[2]?.address().switch().name).toBe('scAddressTypeContract');
    // No tag and a tag of zero are different keys in the contract.
    expect(parts[0]?.[3]?.switch().name).toBe('scvVoid');
    expect(parts[1]?.[3]?.switch().name).toBe('scvU64');
    expect(parts[1]?.[3]?.u64().toString()).toBe('0');
    expect(allowed[0]?.xdr).not.toBe(allowed[1]?.xdr);
    const daily = keys.filter((key) => key.kind === 'daily');
    expect(daily).toHaveLength(2);
    const dailyKey = xdr.LedgerKey.fromXDR(daily[0]?.xdr ?? '', 'base64').contractData();
    expect(dailyKey.key().vec()?.[0]?.sym().toString()).toBe('Daily');
    expect(dailyKey.durability().name).toBe('persistent');
  });

  it('payout records and tombstones are not in the keep-alive key set', () => {
    const keys = keepAliveKeys(TARGET);
    expect(new Set(keys.map((key) => key.kind))).toEqual(
      new Set(['instance', 'code', 'balance', 'allowed', 'daily']),
    );
    for (const key of keys) {
      const ledgerKey = xdr.LedgerKey.fromXDR(key.xdr, 'base64');
      if (ledgerKey.switch().name !== 'contractData') continue;
      const name = ledgerKey.contractData().key().vec()?.[0]?.sym().toString();
      expect(name).not.toBe('Payout');
    }
    // A target cannot even name one: the type has no field for it, and an
    // unknown field is refused.
    expect(thrown(() => keepAliveKeys({ ...TARGET, payouts: [REF_A] } as never))).toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('gives each entry once, in a stable order', () => {
    const doubled = { ...TARGET, daily: [REF_A, REF_A, REF_B] };
    const keys = keepAliveKeys(doubled);
    expect(new Set(keys.map((key) => key.xdr)).size).toBe(keys.length);
    expect(keepAliveKeys(TARGET)).toEqual(keepAliveKeys(TARGET));
  });

  it('refuses a target it cannot key', () => {
    for (const bad of [
      { ...TARGET, mandate: account(0x11) },
      { ...TARGET, asset: 'CABC' },
      { ...TARGET, wasmHash: 'zz' },
      { ...TARGET, allowed: [{ recipientRef: '0x12', address: account(1), tag: null }] },
      { ...TARGET, allowed: [{ recipientRef: REF_A, address: 'M123', tag: null }] },
      { ...TARGET, allowed: [{ recipientRef: REF_A, address: account(1), tag: -1n }] },
      { ...TARGET, allowed: [{ recipientRef: REF_A, address: account(1), tag: 2n ** 64n }] },
      { ...TARGET, daily: ['0x00'] },
      null,
    ]) {
      expect(thrown(() => keepAliveKeys(bad as never))).toBeInstanceOf(InvalidInputError);
    }
  });
});
