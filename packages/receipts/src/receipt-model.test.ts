// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { I128_MAX, money, sum, toDecimalString, tokenAmount } from '@ujira/core';
import { expect, test } from 'vitest';

import {
  BANK_LEG,
  NETWORK,
  OTHER_NETWORK,
  WALLET_LEG,
  fiat,
  localInput,
  ref,
  splitInput,
  usdc,
  walletInput,
} from '../test/fixtures.js';
import { ReceiptInvalidError } from './errors.js';
import { buildReceipt, feeCap, isWalletLeg, isWalletMethod } from './model.js';
import type { ReceiptInput } from './model.js';

function issuesOf(input: unknown): readonly string[] {
  try {
    buildReceipt(input as ReceiptInput);
  } catch (error) {
    if (error instanceof ReceiptInvalidError) return error.issues;
    throw error;
  }
  throw new Error('expected the receipt to be refused');
}

test('two-leg payout gives one receipt with two legs summing to the total', () => {
  const receipt = buildReceipt(splitInput());

  expect(receipt.legs).toHaveLength(2);
  expect(receipt.legs.map((leg) => leg.method)).toEqual(['bank', 'stellar_wallet']);
  expect(receipt.legs.map((leg) => leg.index)).toEqual([0, 1]);
  expect(sum(receipt.legs.map((leg) => leg.amount))).toEqual(receipt.total);
  expect(toDecimalString(receipt.total)).toBe('306.0000000');
  expect(receipt.legs.map((leg) => leg.receiptRef)).toEqual([ref('1'), ref('2')]);
  expect(receipt.network).toBe(NETWORK);
});

test('charged is the total plus the fee', () => {
  const receipt = buildReceipt(splitInput());
  expect(toDecimalString(receipt.charged)).toBe('307.5300000');
  expect(receipt.fee.bps).toBe(50);
});

test('a zero fee is a fee line like any other', () => {
  const receipt = buildReceipt(splitInput({ fee: { amount: usdc('0'), bps: 0 } }));
  expect(receipt.charged).toEqual(receipt.total);
});

test('the receipt is deeply frozen', () => {
  const receipt = buildReceipt(splitInput());
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt.legs)).toBe(true);
  expect(Object.isFrozen(receipt.legs[0])).toBe(true);
  expect(Object.isFrozen(receipt.legs[0]?.destination)).toBe(true);
  expect(Object.isFrozen(receipt.mandate)).toBe(true);
  expect(Object.isFrozen(receipt.fee)).toBe(true);
  expect(Object.isFrozen(receipt.feeRefunds)).toBe(true);
});

test('a revision carries the receipt and hash it replaces', () => {
  const supersedes = { receiptNumber: 'R-AAAAAAAAAAAA', documentSha256: 'b'.repeat(64) };
  const receipt = buildReceipt(splitInput({ revision: 2, supersedes }));
  expect(receipt.supersedes).toEqual(supersedes);
  expect(Object.isFrozen(receipt.supersedes)).toBe(true);
});

test('a revision and its supersedes link must agree', () => {
  expect(issuesOf(splitInput({ revision: 2 }))).toContain(
    'supersedes (a revision after the first supersedes one)',
  );
  expect(
    issuesOf(
      splitInput({
        supersedes: { receiptNumber: 'R-AAAAAAAAAAAA', documentSha256: 'b'.repeat(64) },
      }),
    ),
  ).toContain('supersedes (a revision after the first supersedes one)');
});

test('legs that do not add up to the total are refused', () => {
  expect(issuesOf(splitInput({ total: usdc('305.9999999') }))).toContain(
    'legs (legs add up to the total)',
  );
});

test('legs must be numbered from 0 in order', () => {
  const legs = [WALLET_LEG, { ...BANK_LEG, index: 0 }];
  expect(issuesOf(splitInput({ legs }))).toEqual([
    'legs.0.index (legs are numbered from 0 in order)',
    'legs.1.index (legs are numbered from 0 in order)',
  ]);
});

test('a payout has between one and four legs', () => {
  expect(issuesOf(splitInput({ legs: [] }))).toEqual(['legs (too_small)']);
  const five = [0, 1, 2, 3, 4].map((index) => ({ ...WALLET_LEG, index }));
  expect(issuesOf(splitInput({ legs: five }))).toContain('legs (too_big)');
});

test('a wallet leg states no local amount and a local leg must', () => {
  const wallet = { ...WALLET_LEG, received: fiat('96', 'USD') };
  const bank = { ...BANK_LEG, received: null };
  expect(issuesOf(splitInput({ legs: [bank, wallet] }))).toEqual([
    'legs.0.received (local legs state the local amount, wallet legs do not)',
    'legs.1.received (local legs state the local amount, wallet legs do not)',
  ]);
});

test('amounts must be positive and fees not negative', () => {
  const legs = [
    { ...BANK_LEG, amount: usdc('306'), received: fiat('0', 'NGN'), railFee: usdc('-1') },
    { ...WALLET_LEG, amount: usdc('0') },
  ];
  expect(issuesOf(splitInput({ legs }))).toEqual([
    'legs.0.railFee (must not be negative)',
    'legs.0.received (must be positive)',
    'legs.1.amount (must be positive)',
  ]);
  expect(
    issuesOf(
      splitInput({
        requested: fiat('0', 'NGN'),
        total: usdc('0'),
        fee: { amount: usdc('0'), bps: 50 },
        legs: [{ ...WALLET_LEG, amount: usdc('0'), index: 0 }],
      }),
    ),
  ).toEqual([
    'requested (must be positive)',
    'total (must be positive)',
    'legs.0.amount (must be positive)',
  ]);
});

test('every reference is on the receipt network', () => {
  const legs = [{ ...BANK_LEG, receiptRef: ref('1', 0, OTHER_NETWORK) }, WALLET_LEG];
  expect(
    issuesOf(
      splitInput({
        receiptRef: ref('f', 0, OTHER_NETWORK),
        legs,
        feeRefunds: [{ amount: usdc('0.5'), receiptRef: ref('9', 0, OTHER_NETWORK) }],
      }),
    ),
  ).toEqual([
    'receiptRef (on the receipt network)',
    'legs.0.receiptRef (every leg settles on the receipt network)',
    'feeRefunds.0.receiptRef (refunds settle on the receipt network)',
  ]);
});

test('a malformed reference is refused', () => {
  expect(issuesOf(splitInput({ receiptRef: 'ujira:tx:v1:stellar:pubnet:XYZ:0' }))).toEqual([
    'receiptRef (a receipt reference)',
  ]);
});

test('the fee is never above the contract cap for its rate', () => {
  expect(feeCap(306_0000000n, 50)).toBe(1_5300000n);
  expect(feeCap(9_999n, 100)).toBe(99n);
  expect(() => buildReceipt(splitInput({ fee: { amount: usdc('1.53'), bps: 50 } }))).not.toThrow();
  expect(issuesOf(splitInput({ fee: { amount: usdc('1.5300001'), bps: 50 } }))).toEqual([
    'fee.amount (above the cap for the rate)',
  ]);
  expect(issuesOf(splitInput({ fee: { amount: usdc('-0.01'), bps: 50 } }))).toEqual([
    'fee.amount (must not be negative)',
  ]);
  expect(issuesOf(splitInput({ fee: { amount: usdc('0'), bps: 101 } }))).toEqual([
    'fee.bps (too_big)',
  ]);
});

test('fee refunds are positive and never more than the fee', () => {
  const ok = buildReceipt(
    splitInput({
      feeRefunds: [
        { amount: usdc('1'), receiptRef: ref('8') },
        { amount: usdc('0.53'), receiptRef: ref('9') },
      ],
    }),
  );
  expect(ok.feeRefunds.map((refund) => toDecimalString(refund.amount))).toEqual([
    '1.0000000',
    '0.5300000',
  ]);
  expect(ok.feeRefunds[0]?.receiptRef).toBe(ref('8'));
  expect(
    issuesOf(
      splitInput({
        feeRefunds: [
          { amount: usdc('1'), receiptRef: ref('8') },
          { amount: usdc('0.5300001'), receiptRef: ref('9') },
        ],
      }),
    ),
  ).toEqual(['feeRefunds (cannot refund more than the fee)']);
  expect(
    issuesOf(splitInput({ feeRefunds: [{ amount: usdc('0'), receiptRef: ref('8') }] })),
  ).toEqual(['feeRefunds.0.amount (must be positive)']);
});

test('amounts that overflow when combined are refused, not thrown', () => {
  const huge = tokenAmount(I128_MAX, 'USDC', usdc('1').chain);
  const legs = [
    { ...WALLET_LEG, index: 0, amount: huge },
    { ...WALLET_LEG, index: 1, amount: huge },
  ];
  expect(issuesOf(splitInput({ total: huge, legs }))).toContain(
    'legs (amounts share the total unit and stay in range)',
  );
  const one = [{ ...WALLET_LEG, index: 0, amount: huge }];
  expect(
    issuesOf(splitInput({ total: huge, legs: one, fee: { amount: usdc('1'), bps: 100 } })),
  ).toEqual(['fee.amount (amounts share the total unit and stay in range)']);
});

test('money is rebuilt through core, so forged or mis-scaled values are refused', () => {
  const forged: Record<string, unknown> = { ...usdc('1') };
  Object.defineProperty(forged, 'amount', { get: () => 1n, enumerable: true });
  const misScaledToken = { ...usdc('306'), scale: 6 };
  const misScaledFiat = { ...fiat('480000', 'NGN'), scale: 3, amount: 480_000_000n };
  const cases: [Partial<Record<keyof ReceiptInput, unknown>>, string][] = [
    [{ total: forged }, 'total (a settlement token amount)'],
    [{ total: misScaledToken }, 'total (a settlement token amount)'],
    [{ total: fiat('306', 'USD') }, 'total (a settlement token amount)'],
    [{ total: null }, 'total (a settlement token amount)'],
    [{ total: { kind: 'other', amount: 1n, scale: 7 } }, 'total (a settlement token amount)'],
    [{ requested: misScaledFiat }, 'requested (fiat money at its minor unit)'],
    [{ requested: usdc('1') }, 'requested (fiat money at its minor unit)'],
    [
      { requested: { kind: 'fiat', amount: 1n, currency: 'XYZ', scale: 2 } },
      'requested (fiat money at its minor unit)',
    ],
  ];
  for (const [override, expected] of cases) {
    expect(issuesOf({ ...splitInput(), ...override })).toContain(expected);
  }
});

test('identifiers and text fields are checked', () => {
  const cases: [Partial<Record<keyof ReceiptInput, unknown>>, string][] = [
    [{ principalId: 'not-a-uuid' }, 'principalId (invalid_format)'],
    [{ receiptNumber: 'R-short' }, 'receiptNumber (invalid_format)'],
    [{ recipientRef: 'A'.repeat(64) }, 'recipientRef (invalid_format)'],
    [{ issuedAt: '2026-10-31T09:15:00Z' }, 'issuedAt (invalid_format)'],
    [{ issuedAt: '2026-10-31T09:15:00.000+01:00' }, 'issuedAt (invalid_format)'],
    [{ network: 'stellar:futurenet' }, 'network (a network ID)'],
    [{ taskId: '' }, 'taskId (too_small)'],
    [{ taskId: 'bad \uD800 text' }, 'taskId (well formed text)'],
    [{ revision: 1.5 }, 'revision (invalid_type)'],
    [{ unexpected: true } as never, '$ (unrecognized_keys)'],
  ];
  for (const [override, expected] of cases) {
    expect(issuesOf({ ...splitInput(), ...override })).toContain(expected);
  }
  expect(() => buildReceipt(splitInput({ taskId: null }))).not.toThrow();
});

test('destination tags are u64 values', () => {
  const tagged = (tag: bigint | null) => [
    { ...BANK_LEG, destination: { masked: '****4821', tag } },
    WALLET_LEG,
  ];
  expect(() => buildReceipt(splitInput({ legs: tagged(2n ** 64n - 1n) }))).not.toThrow();
  expect(issuesOf(splitInput({ legs: tagged(2n ** 64n) }))).toEqual([
    'legs.0.destination.tag (too_big)',
  ]);
  expect(issuesOf(splitInput({ legs: tagged(-1n) }))).toEqual([
    'legs.0.destination.tag (too_small)',
  ]);
});

test('issues name the path and never echo the value', () => {
  const secret = '****9999-private';
  const legs = [{ ...BANK_LEG, destination: { masked: `${secret}${'x'.repeat(40)}`, tag: null } }];
  const issues = issuesOf(splitInput({ legs: [...legs, WALLET_LEG] }));
  expect(issues).toEqual(['legs.0.destination.masked (too_big)']);
  expect(issues.join(' ')).not.toContain(secret);
});

test('wallet and local methods are told apart without naming a chain', () => {
  expect(isWalletMethod('stellar_wallet')).toBe(true);
  expect(isWalletMethod('bank')).toBe(false);
  const receipt = buildReceipt(splitInput());
  expect(receipt.legs.map(isWalletLeg)).toEqual([false, true]);
});

test('the local and wallet fixtures build', () => {
  expect(buildReceipt(walletInput()).legs).toHaveLength(1);
  const local = buildReceipt(localInput());
  const [leg] = local.legs;
  expect(leg?.received).toEqual(money('1290000', 'KES'));
});
