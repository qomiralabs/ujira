// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { expect, test } from 'vitest';

import { ref, splitInput, usdc } from '../test/fixtures.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import {
  RECEIPT_DOCUMENT_FORMAT,
  canonicalReceipt,
  documentSha256,
  parseReceiptDocument,
  receiptDocument,
} from './document.js';
import type { ReceiptDocument } from './document.js';
import { ReceiptInvalidError } from './errors.js';
import { buildReceipt } from './model.js';

const receipt = buildReceipt(
  splitInput({ feeRefunds: [{ amount: usdc('0.5'), receiptRef: ref('9') }] }),
);
const doc = receiptDocument(receipt);

function issuesOf(value: unknown): readonly string[] {
  try {
    parseReceiptDocument(value);
  } catch (error) {
    if (error instanceof ReceiptInvalidError) return error.issues;
    throw error;
  }
  throw new Error('expected the document to be refused');
}

function edited(change: (copy: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  change(copy);
  return copy;
}

test('amounts are decimal strings at their own scale, next to their currency', () => {
  expect(doc.format).toBe(RECEIPT_DOCUMENT_FORMAT);
  expect(doc.requested).toEqual({ amount: '480000.00', currency: 'NGN' });
  expect(doc.total).toEqual({ amount: '306.0000000', currency: 'USDC' });
  expect(doc.fee).toEqual({ amount: '1.5300000', currency: 'USDC', bps: 50 });
  expect(doc.charged).toEqual({ amount: '307.5300000', currency: 'USDC' });
  expect(doc.feeRefunds).toEqual([
    { amount: { amount: '0.5000000', currency: 'USDC' }, receiptRef: ref('9') },
  ]);
  expect(doc.legs[0]).toEqual({
    index: 0,
    method: 'bank',
    destination: { masked: '****4821', tag: '4402118' },
    amount: { amount: '210.0000000', currency: 'USDC' },
    received: { amount: '336000.00', currency: 'NGN' },
    railFee: { amount: '1.2500000', currency: 'USDC' },
    receiptRef: ref('1'),
  });
  expect(doc.legs[1]?.received).toBeNull();
  expect(doc.legs[1]?.destination.tag).toBeNull();
});

test('the document carries the tenant, the payout and the revision', () => {
  expect(doc).toMatchObject({
    principalId: receipt.principalId,
    projectId: receipt.projectId,
    payoutId: receipt.payoutId,
    receiptNumber: 'R-7K2M9Q4X8B1C',
    revision: 1,
    supersedes: null,
    network: receipt.network,
    receiptRef: receipt.receiptRef,
  });
});

test('the canonical form is the sorted, unspaced document and the hash is over it', () => {
  const text = canonicalReceipt(receipt);
  expect(text).toBe(canonicalJson(doc));
  expect(text.startsWith('{"charged":{"amount":"307.5300000","currency":"USDC"},"fee":')).toBe(
    true,
  );
  // Compact JSON.stringify output has no whitespace outside strings.
  expect(JSON.stringify(JSON.parse(text))).toBe(text);
  expect(documentSha256(receipt)).toBe(sha256Hex(text));
  expect(documentSha256(receipt)).toMatch(/^[0-9a-f]{64}$/);
});

test('the hash of a known receipt is pinned, so the format cannot drift unnoticed', () => {
  expect(documentSha256(buildReceipt(splitInput()))).toBe(
    '2a59f184c9944d5529679d07fda38cdaffa7b070f0fa8a53218a28fc61002c42',
  );
});

test('a document reads back into the same receipt', () => {
  const reread = parseReceiptDocument(JSON.parse(JSON.stringify(doc)));
  expect(reread).toEqual(receipt);
  expect(documentSha256(reread)).toBe(documentSha256(receipt));
});

test('a document that is not in canonical form is refused', () => {
  const notCanonical = '$ (the document is not the canonical form of its receipt)';
  // The same value, spelled at the wrong scale.
  expect(
    issuesOf(
      edited((copy) => {
        copy['total'] = { amount: '306', currency: 'USDC' };
      }),
    ),
  ).toEqual([notCanonical]);
  // Charged must be total plus fee.
  expect(
    issuesOf(
      edited((copy) => {
        copy['charged'] = { amount: '307.5300001', currency: 'USDC' };
      }),
    ),
  ).toEqual([notCanonical]);
});

test('a tampered amount that breaks the model is refused', () => {
  expect(
    issuesOf(
      edited((copy) => {
        copy['total'] = { amount: '306.0000001', currency: 'USDC' };
      }),
    ),
  ).toEqual(['legs (legs add up to the total)']);
});

test('amounts that do not parse are listed together', () => {
  expect(
    issuesOf(
      edited((copy) => {
        copy['total'] = { amount: '1.00000001', currency: 'USDC' };
        copy['requested'] = { amount: '1', currency: 'XYZ' };
      }),
    ),
  ).toEqual(['total (INVALID_AMOUNT)', 'requested (UNKNOWN_CURRENCY)']);
});

test('the shape is checked before anything is read', () => {
  expect(issuesOf(null)).toEqual(['$ (invalid_type)']);
  expect(
    issuesOf(
      edited((copy) => {
        copy['format'] = 'ujira.receipt.v2';
      }),
    ),
  ).toEqual(['format (invalid_value)']);
  expect(
    issuesOf(
      edited((copy) => {
        copy['extra'] = 1;
      }),
    ),
  ).toEqual(['$ (unrecognized_keys)']);
  expect(
    issuesOf(
      edited((copy) => {
        copy['total'] = { amount: 306, currency: 'USDC' };
      }),
    ),
  ).toEqual(['total.amount (invalid_type)']);
  expect(
    issuesOf(
      edited((copy) => {
        copy['network'] = 'stellar:futurenet';
      }),
    ),
  ).toEqual(['network (unknown)']);
});

test('model rules still apply to a document', () => {
  expect(
    issuesOf(
      edited((copy) => {
        copy['revision'] = 1.5;
      }),
    ),
  ).toEqual(['revision (invalid_type)']);
  expect(
    issuesOf(
      edited((copy) => {
        const legs = copy['legs'] as ReceiptDocument['legs'];
        copy['legs'] = [
          { ...legs[0], destination: { masked: '****4821', tag: '18446744073709551616' } },
          legs[1],
        ];
      }),
    ),
  ).toEqual(['legs.0.destination.tag (too_big)']);
});
