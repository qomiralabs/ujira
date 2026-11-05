// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the receipt files (export.ts).
 *
 * receiptsCsv writes one row per receipt with the canonical document in it, so
 * each row can be checked against its hash. Text a spreadsheet would run as a
 * formula is neutralised, and a row from another tenant is refused. receiptPdf
 * writes a valid plain text PDF from the same document.
 */

import type { TenantScope } from '@ujira/chain-adapter';
import { expect, test } from 'vitest';

import { BANK_LEG, ref, splitInput, usdc } from '../test/fixtures.js';
import { canonicalReceipt, documentSha256, receiptDocument } from './document.js';
import { ReceiptTenantMismatchError } from './errors.js';
import { receiptPdf, receiptsCsv } from './export.js';
import type { StoredReceipt } from './issue.js';
import { buildReceipt } from './model.js';
import type { ReceiptInput } from './model.js';

function stored(overrides: Partial<ReceiptInput> = {}): StoredReceipt {
  const receipt = buildReceipt(splitInput(overrides));
  return { payoutId: receipt.payoutId, receipt, documentSha256: documentSha256(receipt) };
}

const SCOPE = {
  principalId: stored().receipt.principalId,
  projectId: stored().receipt.projectId,
} as TenantScope;

// RFC 4180, the other way round, so the writer is tested by what a reader gets.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text.charAt(i + 1) === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += char;
  }
  return rows;
}

function rowsOf(text: string): Record<string, string>[] {
  const [header = [], ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));
}

test('CSV rows equal the canonical documents', () => {
  const list = [
    stored(),
    stored({ receiptNumber: 'R-AAAAAAAAAAAA', taskId: 'task, with "quotes"' }),
    stored({ receiptNumber: 'R-BBBBBBBBBBBB', taskId: null }),
  ];
  const rows = rowsOf(receiptsCsv(SCOPE, list));
  expect(rows).toHaveLength(list.length);
  for (const [i, row] of rows.entries()) {
    const entry = list[i];
    if (entry === undefined) throw new Error('a row too many');
    const doc = receiptDocument(entry.receipt);
    expect(row['document']).toBe(canonicalReceipt(entry.receipt));
    expect(row['document_sha256']).toBe(entry.documentSha256);
    expect(row).toMatchObject({
      receipt_number: doc.receiptNumber,
      revision: String(doc.revision),
      issued_at: doc.issuedAt,
      principal_id: doc.principalId,
      project_id: doc.projectId,
      payout_id: doc.payoutId,
      task_id: doc.taskId ?? '',
      mandate_id: doc.mandate.id,
      network: doc.network,
      receipt_ref: doc.receiptRef,
      requested_amount: doc.requested.amount,
      requested_currency: doc.requested.currency,
      total_amount: doc.total.amount,
      fee_amount: doc.fee.amount,
      fee_bps: String(doc.fee.bps),
      charged_amount: doc.charged.amount,
      currency: doc.total.currency,
      leg_count: String(doc.legs.length),
    });
  }
});

test('an empty export is the header alone', () => {
  const text = receiptsCsv(SCOPE, []);
  expect(text.endsWith('\r\n')).toBe(true);
  expect(rowsOf(text)).toEqual([]);
  expect(parseCsv(text)[0]?.[0]).toBe('receipt_number');
});

test('text a spreadsheet would run as a formula is neutralised', () => {
  for (const taskId of ['=SUM(A1)', '+1', '-1', '@cmd']) {
    const [row] = rowsOf(receiptsCsv(SCOPE, [stored({ taskId })]));
    expect(row?.['task_id']).toBe(`'${taskId}`);
    // The document keeps what was recorded, or it would no longer match its hash.
    expect(row?.['document']).toContain(JSON.stringify(taskId));
  }
});

test('a row from another tenant is refused, not filtered', () => {
  const other = {
    principalId: '11111111-1111-4111-8111-111111111111',
    projectId: SCOPE.projectId,
  } as TenantScope;
  expect(() => receiptsCsv(other, [stored()])).toThrow(ReceiptTenantMismatchError);
  const otherProject = {
    principalId: SCOPE.principalId,
    projectId: '22222222-2222-4222-8222-222222222222',
  } as TenantScope;
  expect(() => receiptsCsv(otherProject, [stored()])).toThrow(ReceiptTenantMismatchError);
});

function textOf(pdf: Uint8Array): string {
  return Buffer.from(pdf).toString('latin1');
}

test('a PDF is well formed: every offset and length is what it says', () => {
  const text = textOf(receiptPdf(stored()));
  expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  expect(text.endsWith('%%EOF\n')).toBe(true);
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
  expect(text.slice(xrefAt, xrefAt + 5)).toBe('xref\n');
  const entries = text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm);
  const offsets = Array.from(entries, (entry) => Number(entry[1]));
  expect(offsets.length).toBeGreaterThanOrEqual(5);
  for (const [i, offset] of offsets.entries()) {
    expect(text.slice(offset).startsWith(`${String(i + 1)} 0 obj\n`)).toBe(true);
  }
  for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = match.index + match[0].length;
    expect(text.slice(start + Number(match[1])).startsWith('\nendstream')).toBe(true);
  }
});

test('a PDF states the document, amounts and references included', () => {
  const entry = stored({ feeRefunds: [{ amount: usdc('0.5'), receiptRef: ref('9') }] });
  const text = textOf(receiptPdf(entry));
  const doc = receiptDocument(entry.receipt);
  for (const expected of [
    doc.receiptNumber,
    'USDC 306.0000000',
    'NGN 480000.00',
    'USDC 1.5300000 at 50 bps',
    'USDC 307.5300000',
    'Fee refund USDC 0.5000000',
    'Destination tag 4402118',
    'Task annotation-batch-118',
    doc.mandate.id,
    entry.documentSha256.slice(0, 60),
  ]) {
    expect(text).toContain(expected);
  }
});

test('a PDF stays valid with awkward text and more lines than a page', () => {
  const accented = `caf${String.fromCharCode(0xe9)} (first) \\ second`;
  const entry = stored({
    revision: 2,
    supersedes: { receiptNumber: 'R-AAAAAAAAAAAA', documentSha256: 'b'.repeat(64) },
    taskId: accented,
    mandate: { id: '8f4e2b6a-1c3d-4a7e-9b5f-0d2c6e8a4f13', name: 'M'.repeat(100) },
    total: usdc('840'),
    fee: { amount: usdc('4'), bps: 50 },
    feeRefunds: [
      { amount: usdc('0.1'), receiptRef: ref('5') },
      { amount: usdc('0.1'), receiptRef: ref('6') },
    ],
    legs: [0, 1, 2, 3].map((index) => ({
      ...BANK_LEG,
      index,
      receiptRef: ref(String(index + 1)),
    })),
  });
  const text = textOf(receiptPdf(entry));
  expect(text).toContain('(Task caf? \\(first\\) \\\\ second) Tj');
  // The mandate line is longer than the width, so it wraps rather than running off.
  expect(text).toContain(`(Mandate ${'M'.repeat(78)}) Tj`);
  expect(text).toContain('/Count 2');
  expect(text).toContain('Replaces R-AAAAAAAAAAAA');
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
  const offsets = Array.from(text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm), (m) =>
    Number(m[1]),
  );
  for (const [i, offset] of offsets.entries()) {
    expect(text.slice(offset).startsWith(`${String(i + 1)} 0 obj\n`)).toBe(true);
  }
});
