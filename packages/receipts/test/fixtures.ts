// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Receipts for tests. The split example is the one in the receipts guide:
// an expert in Lagos paid NGN 480,000.00, part to a bank and part to their
// own wallet.

import { parseMoney, parseTokenAmount } from '@ujira/core';
import type { FiatCurrencyCode, Money, TokenAmount } from '@ujira/core';
import { chainOf } from '@ujira/chain-adapter';
import type { NetworkId } from '@ujira/chain-adapter';

import type { NetworkPresentation, ReceiptInput, ReceiptLegInput } from '../src/index.js';

export const NETWORK: NetworkId = 'stellar:pubnet';
export const OTHER_NETWORK: NetworkId = 'stellar:testnet';

export function usdc(text: string): TokenAmount {
  return parseTokenAmount(text, 'USDC', chainOf(NETWORK));
}

export function fiat(text: string, currency: FiatCurrencyCode): Money {
  return parseMoney(text, currency);
}

/** A transaction hash made of one repeated hex character, easy to spot in output. */
export function txHash(char: string): string {
  return char.repeat(64);
}

export function ref(char: string, eventIndex = 0, network: NetworkId = NETWORK): string {
  return `ujira:tx:v1:${network}:${txHash(char)}:${String(eventIndex)}`;
}

const BASE = {
  principalId: '0b6f3a52-7d1e-4c55-9a43-2f1d8e6b7c90',
  projectId: '5e2c9d14-3b7a-4f68-8c21-9d0e4a6b1f37',
  receiptNumber: 'R-7K2M9Q4X8B1C',
  revision: 1,
  supersedes: null,
  issuedAt: '2026-10-31T09:15:00.000Z',
  payoutId: 'c3a1e7f2-9b4d-4e86-a2f5-7d3c1b9e0a64',
  taskId: 'annotation-batch-118',
  mandate: { id: '8f4e2b6a-1c3d-4a7e-9b5f-0d2c6e8a4f13', name: 'Contributor payouts' },
  recipientRef: 'a'.repeat(64),
  network: NETWORK,
  receiptRef: ref('f', 2),
  feeRefunds: [],
} as const;

export const BANK_LEG: ReceiptLegInput = {
  index: 0,
  method: 'bank',
  destination: { masked: '****4821', tag: 4_402_118n },
  amount: usdc('210'),
  received: fiat('336000', 'NGN'),
  railFee: usdc('1.25'),
  receiptRef: ref('1'),
};

export const WALLET_LEG: ReceiptLegInput = {
  index: 1,
  method: 'stellar_wallet',
  destination: { masked: 'GBXQ...7KLM', tag: null },
  amount: usdc('96'),
  received: null,
  railFee: usdc('0'),
  receiptRef: ref('2'),
};

/** Two legs: NGN 336,000.00 to a bank and 96.00 USDC to the recipient's wallet. */
export function splitInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    ...BASE,
    requested: fiat('480000', 'NGN'),
    total: usdc('306'),
    fee: { amount: usdc('1.53'), bps: 50 },
    legs: [BANK_LEG, WALLET_LEG],
    ...overrides,
  };
}

/** One leg to the recipient's own wallet. */
export function walletInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    ...BASE,
    requested: fiat('100', 'USD'),
    total: usdc('100'),
    fee: { amount: usdc('0.5'), bps: 50 },
    legs: [{ ...WALLET_LEG, index: 0, amount: usdc('100'), receiptRef: ref('3') }],
    ...overrides,
  };
}

/** One leg to mobile money in Kenya. */
export function localInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    ...BASE,
    requested: fiat('12900', 'KES'),
    total: usdc('100'),
    fee: { amount: usdc('0.75'), bps: 75 },
    legs: [
      {
        index: 0,
        method: 'mobile_money',
        destination: { masked: '+254 *** 512', tag: 77n },
        amount: usdc('100'),
        received: fiat('12900', 'KES'),
        railFee: usdc('0.9'),
        receiptRef: ref('4'),
      },
    ],
    ...overrides,
  };
}

const NAMES = new Map<string, string>([
  [NETWORK, 'Stellar'],
  [OTHER_NETWORK, 'Stellar testnet'],
]);

/** What configuration would supply: a display name and an explorer link per network. */
export const networks: NetworkPresentation = {
  name: (network) => NAMES.get(network) ?? 'Unknown network',
  transactionUrl: (network, hash) => `https://explorer.example/${network}/tx/${hash}`,
};
