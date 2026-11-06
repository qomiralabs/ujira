// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for public receipt verification (verify.ts), against the fake chain
 * adapter.
 *
 * The receipt number and the code printed on it find a receipt; anything else
 * answers null, the same for both. A document that no longer matches its hash
 * fails and shows no receipt. A receipt the chain does not confirm, or that says
 * something other than the chain, fails. An outage or a deadline is
 * 'unavailable'. Whatever the outcome, the caller gets the recipient view and
 * nothing that belongs to the principal.
 */

import { formatReceiptRef } from '@ujira/chain-adapter';
import type { ChainAdapter, ReceiptVerification } from '@ujira/chain-adapter';
import {
  deployMandate,
  drive,
  fakeAdapterHarness,
  finalReceipt,
  payRequest,
} from '@ujira/chain-adapter/testing';
import type { AdapterHarness } from '@ujira/chain-adapter/testing';
import { money, tokenAmount } from '@ujira/core';
import { expect, test } from 'vitest';

import { documentSha256 } from './document.js';
import { issueReceipt } from './issue.js';
import type { StoredReceipt } from './issue.js';
import { buildReceipt } from './model.js';
import type { Receipt, ReceiptInput } from './model.js';
import { VERIFICATION_CODE, verificationCodeFor, verifyPublicReceipt } from './verify.js';
import type { PublicReceiptPorts } from './verify.js';

const PAYOUT = 'c3a1e7f2-9b4d-4e86-a2f5-7d3c1b9e0a64';
const OPTS = { correlationId: 'corr-1' };
const LOCALE = 'en-US';
const TAG = 4_402_118n;
const MANDATE_NAME = 'Contributors';
const networks = {
  name: () => 'Stellar',
  transactionUrl: (_network: string, hash: string) => `https://explorer.example/tx/${hash}`,
};

/** A real payout on the fake chain and the receipt issued for it. */
async function issued(method: 'stellar_wallet' | 'mobile_money' = 'stellar_wallet') {
  const h: AdapterHarness = fakeAdapterHarness();
  const m = await deployMandate(h);
  const req = await payRequest(h, m, 'receipt', { total: 1_000_000n });
  finalReceipt((await drive(h.adapter, req)).at(-1));
  const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', h.adapter.chain);
  const rows: StoredReceipt[] = [];
  const outcome = await issueReceipt(
    {
      store: {
        latest: () => Promise.resolve(rows.at(-1) ?? null),
        insert: (_scope, row) => {
          rows.push(row);
          return Promise.resolve('inserted');
        },
      },
      paidPayout: () =>
        Promise.resolve({
          scope: h.scope,
          id: PAYOUT,
          chainPayoutId: req.payoutId,
          taskId: 'annotation-batch-118',
          mandate: { id: '8f4e2b6a-1c3d-4a7e-9b5f-0d2c6e8a4f13', name: MANDATE_NAME, ref: m.ref },
          recipientRef: 'a'.repeat(64),
          requested: money('10', 'USD'),
          total: usdc(1_000_000n),
          fee: { amount: usdc(0n), bps: 0 },
          legs: [
            {
              index: 0,
              method,
              destination: { masked: 'GBXQ...7KLM', tag: null },
              received: method === 'stellar_wallet' ? null : money('1290', 'KES'),
              railFee: usdc(0n),
            },
          ],
        }),
      adapter: () => h.adapter,
      alerts: { receiptBlocked: () => undefined },
      clock: { nowSeconds: () => 1_793_520_000n },
      chainTimeoutMs: 5000,
    },
    h.scope,
    PAYOUT,
    OPTS,
  );
  if (outcome.status !== 'issued') throw new Error('expected a receipt');
  return { h, stored: outcome.stored };
}

function portsFor(
  h: AdapterHarness,
  stored: StoredReceipt | null,
  overrides: Partial<PublicReceiptPorts> = {},
): PublicReceiptPorts {
  return {
    byNumber: (number) => Promise.resolve(stored?.receipt.receiptNumber === number ? stored : null),
    adapter: () => h.adapter,
    networks,
    chainTimeoutMs: 5000,
    ...overrides,
  };
}

function requestFor(stored: StoredReceipt) {
  return {
    receiptNumber: stored.receipt.receiptNumber,
    code: verificationCodeFor(stored.documentSha256),
    locale: LOCALE,
  };
}

function rebuilt(receipt: Receipt, changes: Partial<ReceiptInput>): Receipt {
  const input: Record<string, unknown> = { ...receipt, ...changes };
  // Derived when it is built, so it is not part of the input.
  Reflect.deleteProperty(input, 'charged');
  return buildReceipt(input as unknown as ReceiptInput);
}

function answering(answer: ReceiptVerification): Pick<ChainAdapter, 'verifyReceipt'> {
  return { verifyReceipt: () => Promise.resolve(answer) };
}

test('a receipt the chain confirms verifies', async () => {
  const { h, stored } = await issued();
  expect(await verifyPublicReceipt(portsFor(h, stored), requestFor(stored), OPTS)).toMatchObject({
    status: 'verified',
    reason: null,
    receipt: { view: 'recipient', receiptNumber: stored.receipt.receiptNumber },
  });
});

test('a tampered receipt fails verification', async () => {
  const { h, stored } = await issued();
  const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', h.adapter.chain);

  // The stored document was changed, and the hash beside it was not.
  const edited: StoredReceipt = {
    ...stored,
    receipt: rebuilt(stored.receipt, { requested: money('99', 'USD') }),
  };
  expect(await verifyPublicReceipt(portsFor(h, edited), requestFor(edited), OPTS)).toEqual({
    status: 'failed',
    reason: 'document_changed',
    receipt: null,
  });

  // Rewritten with a fresh hash, so only the chain can tell.
  const [leg] = stored.receipt.legs;
  if (leg === undefined) throw new Error('expected a leg');
  const forged = rebuilt(stored.receipt, {
    total: usdc(2_000_000n),
    legs: [{ ...leg, amount: usdc(2_000_000n) }],
  });
  const reissued: StoredReceipt = {
    ...stored,
    receipt: forged,
    documentSha256: documentSha256(forged),
  };
  expect(
    await verifyPublicReceipt(portsFor(h, reissued), requestFor(reissued), OPTS),
  ).toMatchObject({
    status: 'failed',
    reason: 'not_confirmed',
  });

  // Pointed at a transaction that does not exist.
  const elsewhere = rebuilt(stored.receipt, {
    receiptRef: formatReceiptRef({
      network: stored.receipt.network,
      txHash: 'b'.repeat(64),
      eventIndex: 0,
    }),
  });
  const moved: StoredReceipt = {
    ...stored,
    receipt: elsewhere,
    documentSha256: documentSha256(elsewhere),
  };
  expect(await verifyPublicReceipt(portsFor(h, moved), requestFor(moved), OPTS)).toMatchObject({
    status: 'failed',
    reason: 'not_confirmed',
  });
});

test('public view has no mandate, principal or destination tag', async () => {
  const { h, stored } = await issued();
  const tagged = rebuilt(stored.receipt, {
    legs: stored.receipt.legs.map((leg) => ({
      ...leg,
      destination: { masked: leg.destination.masked, tag: TAG },
    })),
  });
  const entry: StoredReceipt = {
    ...stored,
    receipt: tagged,
    documentSha256: documentSha256(tagged),
  };
  // Whatever the chain says about the rewritten leg, the view is the same.
  const outcome = await verifyPublicReceipt(portsFor(h, entry), requestFor(entry), OPTS);
  const text = JSON.stringify(outcome);
  expect(outcome?.receipt).not.toBeNull();
  for (const hidden of [
    tagged.principalId,
    tagged.projectId,
    tagged.payoutId,
    tagged.mandate.id,
    MANDATE_NAME,
    tagged.recipientRef,
    tagged.taskId ?? 'unset',
    TAG.toString(),
    entry.documentSha256,
  ]) {
    expect(text).not.toContain(hidden);
  }
  expect(Object.keys(outcome?.receipt ?? {}).sort()).toEqual(
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

test('a local-currency receipt verifies in its own terms', async () => {
  const { h, stored } = await issued('mobile_money');
  const outcome = await verifyPublicReceipt(portsFor(h, stored), requestFor(stored), OPTS);
  expect(outcome?.status).toBe('verified');
  expect(JSON.stringify(outcome)).not.toMatch(/usdc|stellar|chain|network|hash|transaction/i);
});

test('an unknown number and a wrong code answer the same, and the chain is not asked', async () => {
  const { h, stored } = await issued();
  const adapter = {
    verifyReceipt: () => Promise.reject(new Error('must not be called')),
  };
  const ports = portsFor(h, stored, { adapter: () => adapter });
  const req = requestFor(stored);
  expect(
    await verifyPublicReceipt(ports, { ...req, receiptNumber: 'R-000000000000' }, OPTS),
  ).toBeNull();
  expect(await verifyPublicReceipt(ports, { ...req, code: 'A'.repeat(20) }, OPTS)).toBeNull();
  expect(await verifyPublicReceipt(ports, { ...req, code: 'short' }, OPTS)).toBeNull();
});

test('each revision has its own code, in the documented shape', () => {
  const first = verificationCodeFor('a'.repeat(64));
  expect(first).toMatch(VERIFICATION_CODE);
  expect(verificationCodeFor('a'.repeat(64))).toBe(first);
  expect(verificationCodeFor('b'.repeat(64))).not.toBe(first);
});

test('a block on the chain fails, and an expired read is not held against the receipt', async () => {
  const { h, stored } = await issued();
  for (const reason of ['not_found', 'reorged', 'mismatch'] as const) {
    const adapter = answering({ ok: false, reason });
    expect(
      await verifyPublicReceipt(
        portsFor(h, stored, { adapter: () => adapter }),
        requestFor(stored),
        OPTS,
      ),
    ).toMatchObject({ status: 'failed', reason: 'not_confirmed' });
  }
  const adapter = answering({ ok: false, reason: 'outside_rpc_retention' });
  expect(
    await verifyPublicReceipt(
      portsFor(h, stored, { adapter: () => adapter }),
      requestFor(stored),
      OPTS,
    ),
  ).toMatchObject({ status: 'unavailable', reason: null });
});

test('an outage or a deadline says nothing about the receipt', async () => {
  const { h, stored } = await issued();
  const silent = { verifyReceipt: () => new Promise<never>(() => undefined) };
  expect(
    await verifyPublicReceipt(
      portsFor(h, stored, { adapter: () => silent, chainTimeoutMs: 10 }),
      requestFor(stored),
      OPTS,
    ),
  ).toMatchObject({ status: 'unavailable' });
  h.faults?.chainDown(true);
  expect(await verifyPublicReceipt(portsFor(h, stored), requestFor(stored), OPTS)).toMatchObject({
    status: 'unavailable',
  });
});

test('any other error passes through', async () => {
  const { h, stored } = await issued();
  const failure = new Error('not an outage');
  const broken = { verifyReceipt: () => Promise.reject(failure) };
  await expect(
    verifyPublicReceipt(portsFor(h, stored, { adapter: () => broken }), requestFor(stored), OPTS),
  ).rejects.toBe(failure);
});
