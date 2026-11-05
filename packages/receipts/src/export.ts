// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Receipts as files a principal keeps. Both come straight from the canonical
// document, so an export can never say something the hashed record does not.
// PDF is written by hand rather than through a library: a receipt is a page
// of plain text, and that is about a hundred lines against a dependency that
// parses fonts and images for every process that loads this package.

import type { TenantScope } from '@ujira/chain-adapter';

import { canonicalReceipt, receiptDocument } from './document.js';
import type { AmountDocument } from './document.js';
import { ReceiptTenantMismatchError } from './errors.js';
import type { StoredReceipt } from './issue.js';
import type { Receipt } from './model.js';

const CSV_COLUMNS = [
  'receipt_number',
  'revision',
  'issued_at',
  'principal_id',
  'project_id',
  'payout_id',
  'task_id',
  'mandate_id',
  'network',
  'receipt_ref',
  'requested_amount',
  'requested_currency',
  'total_amount',
  'fee_amount',
  'fee_bps',
  'charged_amount',
  'currency',
  'leg_count',
  'document_sha256',
  'document',
] as const;

// A spreadsheet runs a cell that starts with one of these as a formula, and a
// task id is text the integrator chose.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * One CSV row per receipt, with the fields an accountant filters on and the
 * canonical document itself, so every row can be checked against its hash.
 * Rows from another tenant are refused rather than filtered: a store that
 * returned one has a bug, and it must not end up in someone's file.
 */
export function receiptsCsv(scope: TenantScope, rows: readonly StoredReceipt[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const { receipt, documentSha256 } of rows) {
    if (receipt.principalId !== scope.principalId || receipt.projectId !== scope.projectId) {
      throw new ReceiptTenantMismatchError('the store answered for another tenant');
    }
    const doc = receiptDocument(receipt);
    const cells: Readonly<Record<(typeof CSV_COLUMNS)[number], string>> = {
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
      document_sha256: documentSha256,
      document: canonicalReceipt(receipt),
    };
    lines.push(CSV_COLUMNS.map((column) => csvCell(cells[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

const PDF_LINE_WIDTH = 86;
const PDF_LINES_PER_PAGE = 50;

function amount(value: AmountDocument): string {
  return `${value.currency} ${value.amount}`;
}

function receiptLines(receipt: Receipt, hash: string): string[] {
  const doc = receiptDocument(receipt);
  const lines = [
    `UJIRA receipt ${doc.receiptNumber}`,
    `Revision ${String(doc.revision)}`,
    ...(doc.supersedes === null ? [] : [`Replaces ${doc.supersedes.receiptNumber}`]),
    `Issued at ${doc.issuedAt}`,
    '',
    `Payout ${doc.payoutId}`,
    ...(doc.taskId === null ? [] : [`Task ${doc.taskId}`]),
    `Mandate ${doc.mandate.name} (${doc.mandate.id})`,
    `Recipient reference ${doc.recipientRef}`,
    `Network ${doc.network}`,
    `Reference ${doc.receiptRef}`,
    '',
    `Requested ${amount(doc.requested)}`,
    `Total ${amount(doc.total)}`,
    `Fee ${amount(doc.fee)} at ${String(doc.fee.bps)} bps`,
    `Charged ${amount(doc.charged)}`,
    ...doc.feeRefunds.flatMap((refund) => [
      `Fee refund ${amount(refund.amount)}`,
      `  Reference ${refund.receiptRef}`,
    ]),
    '',
    ...doc.legs.flatMap((leg) => [
      `Leg ${String(leg.index + 1)}: ${leg.method} to ${leg.destination.masked}`,
      ...(leg.destination.tag === null ? [] : [`  Destination tag ${leg.destination.tag}`]),
      `  Amount ${amount(leg.amount)}`,
      ...(leg.received === null ? [] : [`  Received ${amount(leg.received)}`]),
      `  Rail fee ${amount(leg.railFee)}`,
      `  Reference ${leg.receiptRef}`,
    ]),
    '',
    `Document SHA-256 ${hash}`,
  ];
  return lines.flatMap((line) => {
    const parts: string[] = [];
    for (let at = 0; at < line.length; at += PDF_LINE_WIDTH) {
      parts.push(line.slice(at, at + PDF_LINE_WIDTH));
    }
    return parts.length === 0 ? [''] : parts;
  });
}

// The built in fonts cover plain ASCII without embedding anything, and every
// byte count below relies on one character being one byte.
function pdfText(line: string): string {
  const printable = line.replace(/[^\x20-\x7e]/g, '?');
  return `(${printable.replace(/[\\()]/g, (char) => `\\${char}`)})`;
}

/** A receipt as a plain text PDF, from its canonical document. Amounts are the document's own. */
export function receiptPdf(stored: StoredReceipt): Uint8Array {
  const lines = receiptLines(stored.receipt, stored.documentSha256);
  const pages: string[][] = [];
  for (let at = 0; at < lines.length; at += PDF_LINES_PER_PAGE) {
    pages.push(lines.slice(at, at + PDF_LINES_PER_PAGE));
  }
  const FIRST_PAGE_OBJECT = 4;
  const pageRefs = pages.map((_, i) => `${String(FIRST_PAGE_OBJECT + i * 2)} 0 R`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${String(pages.length)} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  for (const [i, page] of pages.entries()) {
    const content = [
      'BT',
      '/F1 9 Tf',
      '12 TL',
      '40 800 Td',
      ...page.map((line) => `${pdfText(line)} Tj T*`),
      'ET',
    ].join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(FIRST_PAGE_OBJECT + i * 2 + 1)} 0 R >>`,
      `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    );
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = out.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`);
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${entries.join('')}`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(out, 'latin1'));
}
