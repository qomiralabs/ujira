// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Receipts are permanent. A correction is a new revision, and the old one stays.
// That a receipt lists every leg of its attempt and adds up is the database's rule,
// checked at commit (UJ016). As everywhere, no method takes a tenant id.
//
// The document is the receipt: what its hash covers, what an export carries, and what
// a public check compares. It is stored as the exact text it was hashed from, because
// anything that parsed and rewrote it would change the hash.

import { createHash } from 'node:crypto';

import type { TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { amountParam, tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';
import { IdempotencyConflictError, type NetworkId } from './payouts.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

// A correction that does not follow the revision it says it does, so the caller
// was working from an old receipt, or from none.
export class ReceiptRevisionError extends Error {
  readonly code = 'RECEIPT_REVISION';

  constructor(revision: number) {
    super(`revision ${String(revision)} does not follow the latest revision of this receipt`);
    this.name = 'ReceiptRevisionError';
  }
}

// The document does not hash to the hash given with it, so it is not what was issued.
export class ReceiptDocumentHashError extends Error {
  readonly code = 'RECEIPT_DOCUMENT_HASH';

  constructor() {
    super('this receipt document does not match its hash');
    this.name = 'ReceiptDocumentHashError';
  }
}

export interface NewReceiptLeg {
  readonly legIndex: number;
  // Masked for display. A full address does not fit, on purpose: this table is kept
  // for good, and the full one is only ever on the method.
  readonly destinationMasked: string;
  readonly destinationTag?: bigint | null;
  // In the receipt's unit, so raw token units.
  readonly amount: bigint;
  readonly fee?: bigint;
  readonly chainReceiptRef: string;
}

export interface NewReceipt {
  readonly payoutId: string;
  readonly attemptId: string;
  // 1 for the first receipt, and one above the latest for a correction.
  readonly revision: number;
  readonly receiptNumber: string;
  readonly network: NetworkId;
  readonly issuedAt: Date;
  readonly chainReceiptRef: string;
  readonly settlement: TokenAmount;
  // The sum of the legs' fees, in the settlement's unit.
  readonly fee: bigint;
  // UJIRA's take, a line of its own and never folded into a leg's fee. None when left
  // out. Charged is worked out from it.
  readonly takeRate?: {
    readonly amount: bigint;
    readonly bps: number;
    readonly refunded?: bigint;
  };
  // The canonical text, exactly as it was hashed.
  readonly document: string;
  // Lower case hex, as the receipt model writes it.
  readonly documentSha256: string;
  // The hash of the document this one replaces. Null for revision 1.
  readonly supersedesSha256: string | null;
  readonly legs: readonly NewReceiptLeg[];
}

export interface ReceiptLeg {
  readonly legIndex: number;
  readonly destinationMasked: string;
  readonly destinationTag: bigint | null;
  readonly amount: TokenAmount;
  readonly fee: TokenAmount;
  readonly chainReceiptRef: string;
}

export interface Receipt {
  readonly id: string;
  readonly payoutId: string;
  readonly attemptId: string;
  readonly revision: number;
  readonly receiptNumber: string;
  readonly network: NetworkId;
  readonly issuedAt: Date;
  readonly chainReceiptRef: string;
  readonly settlement: TokenAmount;
  readonly fee: TokenAmount;
  readonly takeRate: {
    readonly amount: TokenAmount;
    readonly bps: number;
    readonly refunded: TokenAmount;
  };
  // Settlement plus take rate, which is what left the mandate.
  readonly charged: TokenAmount;
  readonly document: string;
  readonly documentSha256: string;
  readonly supersedesSha256: string | null;
  readonly createdAt: Date;
}

export interface RecordedReceipt {
  readonly receipt: Receipt;
  // False when this revision had already been written with the same document.
  readonly created: boolean;
}

const receiptColumns = [
  'id',
  'payout_id',
  'attempt_id',
  'revision',
  'receipt_number',
  'network',
  'issued_at',
  'chain_receipt_ref',
  'chain',
  'asset',
  'scale',
  'settlement_amount',
  'fee_amount',
  'take_rate_amount',
  'take_rate_bps',
  'take_rate_refunded_amount',
  'charged_amount',
  'canonical_document',
  'document_sha256',
  'supersedes_sha256',
  'created_at',
] as const;

function toReceipt(row: {
  id: string;
  payout_id: string;
  attempt_id: string;
  revision: string;
  receipt_number: string;
  network: string;
  issued_at: Date;
  chain_receipt_ref: string;
  chain: string;
  asset: string;
  scale: number;
  settlement_amount: string;
  fee_amount: string;
  take_rate_amount: string;
  take_rate_bps: string;
  take_rate_refunded_amount: string;
  charged_amount: string | null;
  canonical_document: string;
  document_sha256: Buffer;
  supersedes_sha256: Buffer | null;
  created_at: Date;
}): Receipt {
  const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
  return {
    id: row.id,
    payoutId: row.payout_id,
    attemptId: row.attempt_id,
    // Bounded by the column's check, so this is exact.
    revision: Number(row.revision),
    receiptNumber: row.receipt_number,
    network: row.network,
    issuedAt: row.issued_at,
    chainReceiptRef: row.chain_receipt_ref,
    settlement: tokenFromRow({ amount: row.settlement_amount, ...unit }),
    fee: tokenFromRow({ amount: row.fee_amount, ...unit }),
    takeRate: {
      amount: tokenFromRow({ amount: row.take_rate_amount, ...unit }),
      // Checked to be 0 to 100, so this is exact.
      bps: Number(row.take_rate_bps),
      refunded: tokenFromRow({ amount: row.take_rate_refunded_amount, ...unit }),
    },
    // Null only on a row from before this column, which has no take rate either.
    charged: tokenFromRow({ amount: row.charged_amount ?? row.settlement_amount, ...unit }),
    document: row.canonical_document,
    documentSha256: row.document_sha256.toString('hex'),
    supersedesSha256: row.supersedes_sha256?.toString('hex') ?? null,
    createdAt: row.created_at,
  };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// False when what is stored no longer hashes to the hash stored with it. The table is
// append only, so that means someone went around the database's own rules, and a
// public check must say so rather than show the document.
export function receiptDocumentIntact(receipt: Receipt): boolean {
  return sha256Hex(receipt.document) === receipt.documentSha256;
}

async function latestRow(db: Tx, payoutId: string) {
  return db
    .selectFrom('ujira.receipts')
    .select(receiptColumns)
    .where('payout_id', '=', payoutId)
    .orderBy('revision', 'desc')
    .limit(1)
    .executeTakeFirst();
}

export const receipts = {
  // Safe to retry: the same revision with the same document finds the first, and
  // with a different one is refused. Refused with ReceiptRevisionError unless it
  // directly follows the latest and names that revision's hash, so revisions form a
  // chain and a correction made from a stale copy is noticed.
  record: async (db: Tx, input: NewReceipt): Promise<RecordedReceipt> => {
    if (sha256Hex(input.document) !== input.documentSha256) throw new ReceiptDocumentHashError();
    const latest = await latestRow(db, input.payoutId);
    const current = latest === undefined ? 0 : Number(latest.revision);
    if (input.revision > current + 1 || input.revision < 1) {
      throw new ReceiptRevisionError(input.revision);
    }
    if (
      input.revision === current + 1 &&
      latest !== undefined &&
      input.supersedesSha256 !== latest.document_sha256.toString('hex')
    ) {
      throw new ReceiptRevisionError(input.revision);
    }
    const inserted = await db
      .insertInto('ujira.receipts')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        payout_id: input.payoutId,
        attempt_id: input.attemptId,
        revision: input.revision,
        receipt_number: input.receiptNumber,
        network: input.network,
        issued_at: input.issuedAt,
        chain_receipt_ref: input.chainReceiptRef,
        chain: input.settlement.chain,
        asset: input.settlement.asset,
        scale: input.settlement.scale,
        settlement_amount: amountParam(input.settlement),
        fee_amount: input.fee.toString(),
        take_rate_amount: (input.takeRate?.amount ?? 0n).toString(),
        take_rate_bps: input.takeRate?.bps ?? 0,
        take_rate_refunded_amount: (input.takeRate?.refunded ?? 0n).toString(),
        charged_amount: (input.settlement.amount + (input.takeRate?.amount ?? 0n)).toString(),
        canonical_document: input.document,
        document_sha256: Buffer.from(input.documentSha256, 'hex'),
        supersedes_sha256:
          input.supersedesSha256 === null ? null : Buffer.from(input.supersedesSha256, 'hex'),
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'payout_id', 'revision']).doNothing(),
      )
      .returning(receiptColumns)
      .executeTakeFirst();
    if (inserted === undefined) {
      const first = await db
        .selectFrom('ujira.receipts')
        .select(receiptColumns)
        .where('payout_id', '=', input.payoutId)
        .where('revision', '=', input.revision.toString())
        .executeTakeFirstOrThrow();
      if (first.document_sha256.toString('hex') !== input.documentSha256) {
        throw new IdempotencyConflictError();
      }
      return { receipt: toReceipt(first), created: false };
    }
    if (input.legs.length > 0) {
      await db
        .insertInto('ujira.receipt_legs')
        .values(
          input.legs.map((leg) => ({
            principal_id: CURRENT_PRINCIPAL,
            project_id: CURRENT_PROJECT,
            receipt_id: inserted.id,
            attempt_id: input.attemptId,
            leg_index: leg.legIndex,
            destination_masked: leg.destinationMasked,
            destination_tag: leg.destinationTag?.toString() ?? null,
            amount: leg.amount.toString(),
            fee_amount: (leg.fee ?? 0n).toString(),
            chain: input.settlement.chain,
            asset: input.settlement.asset,
            scale: input.settlement.scale,
            chain_receipt_ref: leg.chainReceiptRef,
          })),
        )
        .execute();
    }
    return { receipt: toReceipt(inserted), created: true };
  },

  latest: async (db: Tx, payoutId: string): Promise<Receipt | undefined> => {
    const row = await latestRow(db, payoutId);
    return row === undefined ? undefined : toReceipt(row);
  },

  revisions: async (db: Tx, payoutId: string): Promise<readonly Receipt[]> => {
    const rows = await db
      .selectFrom('ujira.receipts')
      .select(receiptColumns)
      .where('payout_id', '=', payoutId)
      .orderBy('revision')
      .execute();
    return rows.map(toReceipt);
  },

  // Within this tenant. A public check by number has no tenant yet, so it needs an
  // entry point of its own, with its own narrow role.
  byNumber: async (db: Tx, receiptNumber: string): Promise<Receipt | undefined> => {
    const row = await db
      .selectFrom('ujira.receipts')
      .select(receiptColumns)
      .where('receipt_number', '=', receiptNumber)
      .executeTakeFirst();
    return row === undefined ? undefined : toReceipt(row);
  },

  // For an export, which carries the stored documents as they are.
  list: async (db: Tx, page: PageRequest): Promise<Page<Receipt>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.receipts')
      .select(receiptColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toReceipt), limit, (receipt) => receipt.id);
  },

  legs: async (db: Tx, receiptId: string): Promise<readonly ReceiptLeg[]> => {
    const rows = await db
      .selectFrom('ujira.receipt_legs')
      .select([
        'leg_index',
        'destination_masked',
        'destination_tag',
        'amount',
        'fee_amount',
        'chain',
        'asset',
        'scale',
        'chain_receipt_ref',
      ])
      .where('receipt_id', '=', receiptId)
      .orderBy('leg_index')
      .execute();
    return rows.map((row) => {
      const unit = { asset: row.asset, chain: row.chain, scale: row.scale };
      return {
        legIndex: Number(row.leg_index),
        destinationMasked: row.destination_masked,
        destinationTag: row.destination_tag === null ? null : BigInt(row.destination_tag),
        amount: tokenFromRow({ amount: row.amount, ...unit }),
        fee: tokenFromRow({ amount: row.fee_amount, ...unit }),
        chainReceiptRef: row.chain_receipt_ref,
      };
    });
  },
};

export const receiptRepositories = { receipts } as const;
