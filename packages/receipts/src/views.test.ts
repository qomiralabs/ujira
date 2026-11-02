// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test } from 'vitest';

import {
  BANK_LEG,
  NETWORK,
  fiat,
  localInput,
  networks,
  ref,
  splitInput,
  txHash,
  usdc,
  walletInput,
} from '../test/fixtures.js';
import { documentSha256 } from './document.js';
import { ReceiptPresentationInvalidError } from './errors.js';
import { buildReceipt } from './model.js';
import type { NetworkPresentation } from './views.js';
import { principalView, recipientView } from './views.js';

const options = { locale: 'en-US', networks };
// The core formatters put a no break space between amount and code.
const NBSP = String.fromCharCode(0xa0);

// Words that tell a local-currency recipient about the rail underneath.
const RAIL_WORDS = /usdc|stellar|chain|network|hash|transaction|explorer|token|crypto|wallet/i;

test("a wallet payout's recipient view shows USDC and Stellar", () => {
  const view = recipientView(buildReceipt(walletInput()), options);

  expect(view.total).toBe(`100.00${NBSP}USDC`);
  expect(view.summary).toBe(`100.00${NBSP}USDC paid to your Stellar wallet`);
  expect(view.legs).toEqual([
    {
      method: 'stellar_wallet',
      label: 'to your Stellar wallet',
      received: `100.00${NBSP}USDC`,
      destination: 'GBXQ...7KLM',
      network: 'Stellar',
      transactionHash: txHash('3'),
      transactionUrl: `https://explorer.example/${NETWORK}/tx/${txHash('3')}`,
    },
  ]);
});

test("a local-currency payout's recipient view contains no USDC, chain or transaction hash wording", () => {
  const receipt = buildReceipt(localInput());
  const view = recipientView(receipt, options);
  const text = JSON.stringify(view);

  expect(view.total).toBe(`KSh${NBSP}12,900.00`);
  expect(view.summary).toBe(`KSh${NBSP}12,900.00 paid to mobile money`);
  expect(view.legs).toEqual([
    {
      method: 'mobile_money',
      label: 'to mobile money',
      received: `KSh${NBSP}12,900.00`,
      destination: '+254 *** 512',
    },
  ]);
  expect(text).not.toMatch(RAIL_WORDS);
  for (const leg of receipt.legs) {
    expect(text).not.toContain(leg.receiptRef);
    expect(text).not.toContain(txHash('4'));
  }
  expect(text).not.toContain(receipt.receiptRef);
  expect(text).not.toContain(documentSha256(receipt));
});

test('a split payout shows the local leg in local currency and the wallet leg in USDC', () => {
  const view = recipientView(buildReceipt(splitInput()), options);
  expect(view.total).toBe('₦480,000.00');
  expect(view.summary).toBe(
    `₦480,000.00 paid: ₦336,000.00 to bank, 96.00${NBSP}USDC to your Stellar wallet`,
  );
  const [bank, wallet] = view.legs;
  expect(JSON.stringify(bank)).not.toMatch(RAIL_WORDS);
  expect(wallet).toMatchObject({ network: 'Stellar', transactionHash: txHash('2') });
});

test('the recipient view never carries tenant, mandate, fee or destination tag', () => {
  const receipt = buildReceipt(splitInput());
  const view = recipientView(receipt, options);
  const text = JSON.stringify(view);
  for (const hidden of [
    receipt.principalId,
    receipt.projectId,
    receipt.payoutId,
    receipt.mandate.id,
    receipt.mandate.name,
    receipt.recipientRef,
    '4402118',
    '1.53',
    '1.25',
  ]) {
    expect(text).not.toContain(hidden);
  }
  expect(Object.keys(view).sort()).toEqual(
    [
      'issuedAt',
      'legs',
      'receiptNumber',
      'revision',
      'summary',
      'supersedes',
      'total',
      'view',
    ].sort(),
  );
});

test('a recipient total sums local legs in one currency and falls back to the request otherwise', () => {
  const twoBanks = splitInput({
    legs: [
      { ...BANK_LEG, amount: usdc('200'), received: fiat('320000', 'NGN') },
      {
        ...BANK_LEG,
        index: 1,
        method: 'cash_pickup',
        amount: usdc('106'),
        received: fiat('169600', 'NGN'),
        receiptRef: ref('5'),
      },
    ],
  });
  expect(recipientView(buildReceipt(twoBanks), options).summary).toBe(
    '₦489,600.00 paid: ₦320,000.00 to bank, ₦169,600.00 for cash pickup',
  );
  const twoCurrencies = splitInput({
    legs: [
      { ...BANK_LEG, amount: usdc('200'), received: fiat('320000', 'NGN') },
      {
        ...BANK_LEG,
        index: 1,
        method: 'mobile_money',
        amount: usdc('106'),
        received: fiat('13674', 'KES'),
        receiptRef: ref('5'),
      },
    ],
  });
  expect(recipientView(buildReceipt(twoCurrencies), options).total).toBe('₦480,000.00');
});

test('a correction tells the recipient which receipt number it replaces', () => {
  const supersedes = { receiptNumber: 'R-AAAAAAAAAAAA', documentSha256: 'b'.repeat(64) };
  const view = recipientView(buildReceipt(splitInput({ revision: 2, supersedes })), options);
  expect(view.revision).toBe(2);
  expect(view.supersedes).toBe('R-AAAAAAAAAAAA');
  expect(recipientView(buildReceipt(splitInput()), options).supersedes).toBeNull();
});

test('the principal view adds mandate details, destination tags and the fee line', () => {
  const receipt = buildReceipt(
    splitInput({ feeRefunds: [{ amount: usdc('0.5'), receiptRef: ref('9') }] }),
  );
  const view = principalView(receipt, options);

  expect(view).toMatchObject({
    view: 'principal',
    principalId: receipt.principalId,
    projectId: receipt.projectId,
    payoutId: receipt.payoutId,
    taskId: 'annotation-batch-118',
    mandate: { id: receipt.mandate.id, name: 'Contributor payouts' },
    recipientRef: receipt.recipientRef,
    network: { id: NETWORK, name: 'Stellar' },
    receiptRef: receipt.receiptRef,
    requested: '₦480,000.00',
    total: `306.00${NBSP}USDC`,
    fee: { amount: `1.53${NBSP}USDC`, bps: 50, rate: '0.50%' },
    charged: `307.53${NBSP}USDC`,
    documentSha256: documentSha256(receipt),
  });
  expect(view.feeRefunds).toEqual([
    {
      amount: `0.50${NBSP}USDC`,
      transactionHash: txHash('9'),
      transactionUrl: `https://explorer.example/${NETWORK}/tx/${txHash('9')}`,
    },
  ]);
  expect(view.legs).toEqual([
    {
      index: 0,
      method: 'bank',
      label: 'to bank',
      destination: '****4821',
      destinationTag: '4402118',
      amount: `210.00${NBSP}USDC`,
      received: '₦336,000.00',
      railFee: `1.25${NBSP}USDC`,
      transactionHash: txHash('1'),
      transactionUrl: `https://explorer.example/${NETWORK}/tx/${txHash('1')}`,
    },
    {
      index: 1,
      method: 'stellar_wallet',
      label: "to the recipient's Stellar wallet",
      destination: 'GBXQ...7KLM',
      destinationTag: null,
      amount: `96.00${NBSP}USDC`,
      received: null,
      railFee: `0.00${NBSP}USDC`,
      transactionHash: txHash('2'),
      transactionUrl: `https://explorer.example/${NETWORK}/tx/${txHash('2')}`,
    },
  ]);
});

test('the fee rate is shown from basis points without floats', () => {
  const rateOf = (bps: number, fee: string) =>
    principalView(buildReceipt(splitInput({ fee: { amount: usdc(fee), bps } })), options).fee.rate;
  expect(rateOf(0, '0')).toBe('0.00%');
  expect(rateOf(5, '0.153')).toBe('0.05%');
  expect(rateOf(75, '2.295')).toBe('0.75%');
  expect(rateOf(100, '3.06')).toBe('1.00%');
});

test('amounts follow the locale through the core formatters', () => {
  const view = recipientView(buildReceipt(splitInput()), { locale: 'de-DE', networks });
  expect(view.total).toBe(`480.000,00${NBSP}₦`);
});

test('a network name or link from configuration that cannot be shown is refused', () => {
  const receipt = buildReceipt(walletInput());
  const badName: NetworkPresentation = { ...networks, name: () => '' };
  const badUrl: NetworkPresentation = {
    ...networks,
    transactionUrl: (_network, hash) => `http://explorer.example/tx/${hash}`,
  };
  expect(() => recipientView(receipt, { locale: 'en-US', networks: badName })).toThrow(
    ReceiptPresentationInvalidError,
  );
  expect(() => principalView(receipt, { locale: 'en-US', networks: badUrl })).toThrow(
    ReceiptPresentationInvalidError,
  );
  // A local-only payout never asks for either, so a recipient view still renders.
  expect(() =>
    recipientView(buildReceipt(localInput()), { locale: 'en-US', networks: badUrl }),
  ).not.toThrow();
});

test('a failing configuration lookup is not swallowed', () => {
  const broken: NetworkPresentation = {
    ...networks,
    name: () => {
      throw new Error('configuration unavailable');
    },
  };
  expect(() =>
    recipientView(buildReceipt(walletInput()), { locale: 'en-US', networks: broken }),
  ).toThrow('configuration unavailable');
});
