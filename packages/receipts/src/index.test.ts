// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test } from 'vitest';

import * as receipts from './index.js';

test('the package entry exports the model, document, views and signing', () => {
  expect(receipts.PACKAGE_NAME).toBe('@ujira/receipts');
  for (const name of [
    'buildReceipt',
    'canonicalJson',
    'documentSha256',
    'parseReceiptDocument',
    'principalView',
    'recipientView',
    'receiptDocument',
    'signReceipt',
    'verifyReceiptSignature',
  ] as const) {
    expect(typeof receipts[name]).toBe('function');
  }
});
