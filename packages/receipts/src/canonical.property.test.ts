// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { money, toDecimalString, tokenAmount } from '@ujira/core';
import fc from 'fast-check';
import { expect, test } from 'vitest';

import { BANK_LEG, WALLET_LEG, splitInput, usdc } from '../test/fixtures.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { documentSha256, parseReceiptDocument, receiptDocument } from './document.js';
import { buildReceipt, feeCap } from './model.js';
import type { Receipt } from './model.js';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const { json } = fc.letrec<{ json: Json; list: Json[]; record: Record<string, Json> }>((tie) => ({
  json: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.string({ unit: 'grapheme' }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    tie('list'),
    tie('record'),
  ),
  list: fc.array(tie('json'), { maxLength: 4 }),
  record: fc.dictionary(fc.string({ unit: 'grapheme', maxLength: 6 }), tie('json'), {
    maxKeys: 5,
  }),
}));

const indents = fc.constantFrom<string | number>(0, 1, 2, 4, '\t', ' \n ');

// A small deterministic generator, so a failing case replays from its seed.
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// Rebuilds every object with its keys in a different order. fromEntries
// defines own properties, so a "__proto__" key stays a key.
function reorder(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((item, i) => reorder(item, seed + i));
  if (typeof value !== 'object' || value === null) return value;
  const entries = shuffled(Object.entries(value), seed);
  return Object.fromEntries(entries.map(([key, item], i) => [key, reorder(item, seed * 31 + i)]));
}

test('key order and whitespace never change the hash', () => {
  fc.assert(
    fc.property(json, fc.integer(), indents, (value, seed, indent) => {
      const expected = sha256Hex(canonicalJson(value));
      const text = JSON.stringify(reorder(value, seed), null, indent);
      expect(sha256Hex(canonicalJson(JSON.parse(text)))).toBe(expected);
    }),
  );
});

const units = (max: bigint) => fc.bigInt({ min: 1n, max });

const USDC_CHAIN = usdc('0').chain;
const asUsdc = (amount: bigint) => tokenAmount(amount, 'USDC', USDC_CHAIN);

const receipts = fc
  .record({
    bankAmount: units(10n ** 13n),
    walletAmount: units(10n ** 13n),
    received: units(10n ** 12n),
    railFee: fc.bigInt({ min: 0n, max: 10n ** 9n }),
    bps: fc.integer({ min: 0, max: 100 }),
    tag: fc.option(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { nil: null }),
    revision: fc.integer({ min: 1, max: 9 }),
    taskId: fc.option(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }), { nil: null }),
  })
  .map((r): Receipt => {
    const total = r.bankAmount + r.walletAmount;
    const fee = feeCap(total, r.bps);
    return buildReceipt(
      splitInput({
        revision: r.revision,
        supersedes:
          r.revision === 1
            ? null
            : { receiptNumber: 'R-000000000001', documentSha256: '0'.repeat(64) },
        taskId: r.taskId,
        total: asUsdc(total),
        fee: { amount: asUsdc(fee), bps: r.bps },
        legs: [
          {
            ...BANK_LEG,
            amount: asUsdc(r.bankAmount),
            received: money(r.received, 'NGN'),
            railFee: asUsdc(r.railFee),
            destination: { masked: '****4821', tag: r.tag },
          },
          { ...WALLET_LEG, amount: asUsdc(r.walletAmount) },
        ],
      }),
    );
  });

test('a receipt document hashes the same after its keys and spacing change', () => {
  fc.assert(
    fc.property(receipts, fc.integer(), indents, (receipt, seed, indent) => {
      const text = JSON.stringify(reorder(receiptDocument(receipt), seed), null, indent);
      const reread = parseReceiptDocument(JSON.parse(text));
      expect(documentSha256(reread)).toBe(documentSha256(receipt));
    }),
  );
});

test('changing any leg amount changes the hash', () => {
  fc.assert(
    fc.property(receipts, units(10n ** 6n), (receipt, shift) => {
      const doc = receiptDocument(receipt);
      const [bank, wallet] = doc.legs;
      if (bank === undefined || wallet === undefined) throw new Error('two legs expected');
      // Move value between legs so the total still adds up.
      const moved = (text: string, delta: bigint) =>
        toDecimalString(asUsdc(usdc(text).amount + delta));
      const changed = {
        ...doc,
        legs: [
          { ...bank, amount: { ...bank.amount, amount: moved(bank.amount.amount, shift) } },
          { ...wallet, amount: { ...wallet.amount, amount: moved(wallet.amount.amount, -shift) } },
        ],
      };
      expect(sha256Hex(canonicalJson(changed))).not.toBe(documentSha256(receipt));
    }),
  );
});
