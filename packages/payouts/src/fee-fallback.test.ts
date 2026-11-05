// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the zero fee fallback (fee-fallback.ts), against the fake chain.
 *
 * - The fee address really cannot receive: UJIRA records the decision and sends nothing,
 *   because no key it holds may cancel. A new attempt with no fee goes out only once the
 *   old one has lapsed, proven at final. The recipient is paid once and the mandate is
 *   charged the total only.
 * - A failing leg, a fee address that can receive and a fee of 0 stay on the leg path.
 * - One invoice item per payout and one alert per network until it is fixed, however
 *   many reruns and payouts there are.
 * - A rerun resumes from the chain and from what was recorded, at every step.
 */

import { describe, expect, it, vi } from 'vitest';

import { MandateRuleError } from '@ujira/chain-adapter';
import type {
  NetworkId,
  PayRequest,
  PayoutId,
  ReceivabilityReason,
  TenantScope,
} from '@ujira/chain-adapter';
import {
  act,
  deployMandate,
  drive,
  fakeAdapterHarness,
  payRequest,
  refusalOf,
} from '@ujira/chain-adapter/testing';
import type { TokenAmount } from '@ujira/core';

import { isTransferFailed, onTransferFailed, zeroFeeRequest } from './index.js';
import type { FeeFallbackStore, ZeroFeeResend } from './index.js';

const OPTS = { correlationId: 'fee-fallback' };
const TOTAL = 1_000_000n;
const FEE = 5_000n;
const FUNDS = 10_000_000n;
// The fake mandate's payout time to live, and a moment past it.
const PAST_THE_TTL = 86_401n;

type Harness = ReturnType<typeof fakeAdapterHarness>;
type World = Awaited<ReturnType<typeof setup>>;

interface InvoiceItem {
  readonly scope: TenantScope;
  readonly payout: string;
  readonly fee: TokenAmount;
}

/** The one a database version must match, with a Map in place of each unique constraint. */
function memoryStore(identityOf: (resend: ZeroFeeResend) => Promise<PayRequest>) {
  const decided = new Set<string>();
  const resent = new Map<string, PayRequest>();
  const proofs: ZeroFeeResend['proof'][] = [];
  const items = new Map<string, InvoiceItem>();
  const alarms = new Set<NetworkId>();
  const alerts: { network: NetworkId; reason: ReceivabilityReason }[] = [];
  const keyOf = (scope: TenantScope, id: string) => `${scope.principalId}/${scope.projectId}/${id}`;
  const store: FeeFallbackStore = {
    decideResend: (scope, payoutId) => {
      decided.add(keyOf(scope, payoutId));
      return Promise.resolve();
    },
    resendDecided: (scope, payoutId) => Promise.resolve(decided.has(keyOf(scope, payoutId))),
    resendWithoutFee: async (resend) => {
      const key = keyOf(resend.scope, resend.failed.payoutId);
      const existing = resent.get(key);
      if (existing !== undefined) return existing;
      const request = await identityOf(resend);
      resent.set(key, request);
      proofs.push(resend.proof);
      const item = keyOf(resend.scope, resend.payout);
      if (!items.has(item)) {
        items.set(item, { scope: resend.scope, payout: resend.payout, fee: resend.unpaidFee });
      }
      return request;
    },
    raiseAddressAlarm: (network, reason) => {
      if (!alarms.has(network)) {
        alarms.add(network);
        alerts.push({ network, reason });
      }
      return Promise.resolve();
    },
    clearAddressAlarm: (network) => {
      alarms.delete(network);
      return Promise.resolve();
    },
  };
  return { store, items, alerts, decided, proofs };
}

async function setup(fund: bigint = FUNDS) {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h, { maxFeeBps: 50, fund });
  const memory = memoryStore(async (resend) => {
    const label = `resend:${resend.failed.payoutId}`;
    const fresh = await payRequest(h, m, label, { total: resend.failed.total.amount });
    return zeroFeeRequest(resend.failed, {
      payoutId: fresh.payoutId,
      legKeys: fresh.legs.map((leg) => leg.legKey),
      deadline: fresh.deadline,
      attestations: [],
    });
  });
  const deps = { adapter: h.adapter, store: memory.store };
  return { h, m, deps, ...memory };
}

function faultsOf(h: Harness) {
  const { faults } = h;
  if (faults === null) throw new Error('the fake chain has faults');
  return faults;
}

/** Both sides of the same real problem: the chain refuses, and the ledger shows why. */
function breakFeeAddress(h: Harness): void {
  const { net } = h.world;
  net.faults.transferFails(net.feeAddress);
  net.setLedgerTrustline(net.feeAddress, null);
}

function fixFeeAddress(h: Harness): void {
  const { net } = h.world;
  net.faults.transferFails(net.feeAddress, false);
  net.activateRecipient(net.feeAddress);
}

async function failedPayment(w: World, label: string): Promise<PayRequest> {
  const failed = await payRequest(w.h, w.m, label, { total: TOTAL, fee: FEE });
  const refusal = await refusalOf(drive(w.h.adapter, failed));
  expect(isTransferFailed(refusal)).toBe(true);
  return failed;
}

async function onChainOf(w: World, request: PayRequest) {
  const status = await w.h.adapter.status(
    {
      scope: request.scope,
      mandate: request.mandate,
      payoutId: request.payoutId,
      legs: request.legs.map((leg) => leg.legKey),
    },
    OPTS,
  );
  return status.onChain;
}

function resendOf(outcome: Awaited<ReturnType<typeof onTransferFailed>>): PayRequest {
  if (outcome.kind !== 'resend') throw new Error(`expected a resend, got ${outcome.kind}`);
  return outcome.request;
}

/** A failed payment taken to the point where its attempt has lapsed, ready for the resend. */
async function lapsed(w: World, label: string, payout = `p-${label}`) {
  const failed = await failedPayment(w, label);
  const input = { payout, failed, ...OPTS };
  expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'awaiting_lapse' });
  await w.h.advance(PAST_THE_TTL);
  return { failed, input };
}

describe('fee-fallback', () => {
  it('fee transfer failure lets the attempt lapse and re-requests with fee 0', async () => {
    const w = await setup();
    const { h, m, deps } = w;
    breakFeeAddress(h);
    const failed = await failedPayment(w, 'a');
    const input = { payout: 'p-a', failed, ...OPTS };

    expect(await onTransferFailed(input, deps)).toEqual({ kind: 'awaiting_lapse' });
    expect(await onChainOf(w, failed)).toBe('approved');
    expect(w.items.size).toBe(0);

    await h.advance(PAST_THE_TTL);
    const request = resendOf(await onTransferFailed(input, deps));

    expect(request.fee.amount).toBe(0n);
    expect(request.total).toEqual(failed.total);
    expect(request.attempt).toBe(failed.attempt + 1);
    expect(request.payoutId).not.toBe(failed.payoutId);
    expect(request.legs[0]?.legKey).not.toBe(failed.legs[0]?.legKey);
    expect(request.legs[0]?.amount).toEqual(failed.legs[0]?.amount);
    expect(w.proofs).toEqual([expect.objectContaining({ kind: 'payout_lapsed' })]);

    const before = await h.balance(m.ref.address);
    const recipient = m.recipients[0]?.address;
    if (recipient === undefined) throw new Error('a recipient');
    const paidBefore = await h.balance(recipient);
    expect((await drive(h.adapter, request)).at(-1)?.kind).toBe('final');
    expect(await h.balance(recipient)).toBe(paidBefore + TOTAL);
    expect(await h.balance(m.ref.address)).toBe(before - TOTAL);
    expect(await h.balance({ network: h.adapter.network, value: h.world.net.feeAddress })).toBe(0n);
  });

  it('never tries to cancel, since no key UJIRA holds may', async () => {
    const w = await setup();
    const prepare = vi.spyOn(w.h.adapter, 'prepareMandateAction');
    const submit = vi.spyOn(w.h.adapter, 'submitSigned');
    breakFeeAddress(w.h);
    const { input } = await lapsed(w, 'no-cancel');
    prepare.mockClear();
    submit.mockClear();

    resendOf(await onTransferFailed(input, w.deps));

    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('cannot pay the old attempt once it has lapsed, whatever happens to the address', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const { failed } = await lapsed(w, 'late');
    fixFeeAddress(w.h);
    expect(await refusalOf(drive(w.h.adapter, failed))).toMatchObject({ code: 'MANDATE_RULE' });
  });

  it('leg transfer failure uses the normal leg fallback', async () => {
    const w = await setup();
    const { h, m, deps } = w;
    const recipient = m.recipients[0]?.address;
    if (recipient === undefined) throw new Error('a recipient');
    faultsOf(h).transferFails(recipient);
    const failed = await failedPayment(w, 'leg');

    const outcome = await onTransferFailed({ payout: 'p-leg', failed, ...OPTS }, deps);

    expect(outcome).toEqual({ kind: 'leg_fallback' });
    expect(await onChainOf(w, failed)).toBe('approved');
    expect(w.items.size).toBe(0);
    expect(w.alerts).toEqual([]);
    expect(w.decided.size).toBe(0);
  });

  it('one invoice item per payout', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const { failed, input } = await lapsed(w, 'once', 'p-once');

    const first = resendOf(await onTransferFailed(input, w.deps));
    const again = resendOf(await onTransferFailed(input, w.deps));

    expect(again).toEqual(first);
    expect([...w.items.values()]).toEqual([
      { scope: w.h.scope, payout: 'p-once', fee: failed.fee },
    ]);
  });

  it('records nothing to invoice while the attempt could still land', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const failed = await failedPayment(w, 'waiting');
    const input = { payout: 'p-waiting', failed, ...OPTS };
    await onTransferFailed(input, w.deps);
    await onTransferFailed(input, w.deps);
    expect(w.items.size).toBe(0);
  });

  it('keeps invoice items apart per payout', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const one = await failedPayment(w, 'one');
    const two = await failedPayment(w, 'two');
    const inputs = [
      { payout: 'p-one', failed: one, ...OPTS },
      { payout: 'p-two', failed: two, ...OPTS },
    ];
    for (const input of inputs) await onTransferFailed(input, w.deps);
    await w.h.advance(PAST_THE_TTL);
    for (const input of inputs) await onTransferFailed(input, w.deps);
    expect([...w.items.values()].map((item) => item.payout)).toEqual(['p-one', 'p-two']);
  });

  it('alerts once per network until the address is fixed, then again if it breaks again', async () => {
    const w = await setup();
    const { h } = w;
    breakFeeAddress(h);
    const one = await failedPayment(w, 'first');
    const two = await failedPayment(w, 'second');
    await onTransferFailed({ payout: 'p1', failed: one, ...OPTS }, w.deps);
    await onTransferFailed({ payout: 'p2', failed: two, ...OPTS }, w.deps);
    expect(w.alerts).toEqual([{ network: h.adapter.network, reason: 'NO_TRUSTLINE' }]);

    fixFeeAddress(h);
    const recipient = w.m.recipients[0]?.address;
    if (recipient === undefined) throw new Error('a recipient');
    faultsOf(h).transferFails(recipient);
    const leg = await failedPayment(w, 'leg');
    await onTransferFailed({ payout: 'p3', failed: leg, ...OPTS }, w.deps);
    faultsOf(h).transferFails(recipient, false);

    breakFeeAddress(h);
    const three = await failedPayment(w, 'third');
    await onTransferFailed({ payout: 'p4', failed: three, ...OPTS }, w.deps);
    expect(w.alerts).toHaveLength(2);
  });

  it('stays on the leg path when the request had no fee, without asking the chain', async () => {
    const w = await setup();
    const failed = await payRequest(w.h, w.m, 'free', { total: TOTAL });
    const status = vi.spyOn(w.h.adapter, 'status');
    expect(await onTransferFailed({ payout: 'p', failed, ...OPTS }, w.deps)).toEqual({
      kind: 'leg_fallback',
    });
    expect(status).not.toHaveBeenCalled();
  });

  it('does nothing on a guess when the chain cannot be read', async () => {
    const w = await setup();
    const { h } = w;
    breakFeeAddress(h);
    const failed = await failedPayment(w, 'blind');
    faultsOf(h).rpcLag(600);

    await expect(onTransferFailed({ payout: 'p', failed, ...OPTS }, w.deps)).rejects.toThrow();

    faultsOf(h).rpcLag(0);
    expect(await onChainOf(w, failed)).toBe('approved');
    expect(w.decided.size).toBe(0);
    expect(w.items.size).toBe(0);
  });

  it('never pays again when the first attempt landed after all', async () => {
    const w = await setup();
    const { h } = w;
    breakFeeAddress(h);
    const failed = await failedPayment(w, 'landed');
    const input = { payout: 'p', failed, ...OPTS };
    expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'awaiting_lapse' });

    fixFeeAddress(h);
    expect((await drive(h.adapter, failed)).at(-1)?.kind).toBe('final');
    breakFeeAddress(h);

    expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'already_landed' });
    expect(w.items.size).toBe(0);
  });

  it('does not bring back a payout the principal cancelled before the decision', async () => {
    const w = await setup();
    const { h, m } = w;
    breakFeeAddress(h);
    const failed = await failedPayment(w, 'theirs');
    await act(h, m.ref, { op: 'cancel', payoutId: failed.payoutId }, m.principal);

    const outcome = await onTransferFailed({ payout: 'p', failed, ...OPTS }, w.deps);

    expect(outcome).toMatchObject({ kind: 'attempt_dead', proof: { status: 'cancelled' } });
    expect(w.items.size).toBe(0);
    expect(w.decided.size).toBe(0);
  });

  it('does not bring back a payout the principal cancelled during the wait', async () => {
    const w = await setup();
    const { h, m } = w;
    breakFeeAddress(h);
    const failed = await failedPayment(w, 'changed-mind');
    const input = { payout: 'p', failed, ...OPTS };
    expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'awaiting_lapse' });
    await act(h, m.ref, { op: 'cancel', payoutId: failed.payoutId }, m.principal);

    expect(await onTransferFailed(input, w.deps)).toMatchObject({
      kind: 'attempt_dead',
      proof: { status: 'cancelled' },
    });
    expect(w.items.size).toBe(0);
  });

  it('reports an attempt that is over when the address can receive', async () => {
    const w = await setup();
    const { h, m } = w;
    breakFeeAddress(h);
    const failed = await failedPayment(w, 'gone');
    fixFeeAddress(h);
    await act(h, m.ref, { op: 'cancel', payoutId: failed.payoutId }, m.principal);

    expect(await onTransferFailed({ payout: 'p', failed, ...OPTS }, w.deps)).toMatchObject({
      kind: 'attempt_dead',
    });
    expect(w.alerts).toEqual([]);
  });

  it('a job killed before the resend finishes it, even with the address since fixed', async () => {
    const w = await setup();
    const { h } = w;
    breakFeeAddress(h);
    const { input } = await lapsed(w, 'killed');
    const killed = new Error('worker killed');
    const spy = vi.spyOn(w.store, 'resendWithoutFee').mockRejectedValueOnce(killed);

    await expect(onTransferFailed(input, w.deps)).rejects.toBe(killed);
    spy.mockRestore();
    expect(w.items.size).toBe(0);

    fixFeeAddress(h);
    const request = resendOf(await onTransferFailed(input, w.deps));
    expect(request.fee.amount).toBe(0n);
    expect(w.items.size).toBe(1);
  });

  it('keeps waiting until the proof is final, however often it is asked', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const { input } = await lapsed(w, 'slow');
    const prove = vi.spyOn(w.h.adapter, 'proveDead').mockResolvedValueOnce(null);

    expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'awaiting_lapse' });
    expect(w.items.size).toBe(0);

    prove.mockRestore();
    resendOf(await onTransferFailed(input, w.deps));
    expect(w.items.size).toBe(1);
  });

  it('leaves it to the approver when a rejection comes during the wait', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const failed = await failedPayment(w, 'rejected');
    const input = { payout: 'p', failed, ...OPTS };
    expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'awaiting_lapse' });
    const proof = {
      kind: 'tombstone',
      network: w.h.adapter.network,
      status: 'rejected',
      at: { ledgerOrBlock: 1n, finality: 'final' },
    } as const;
    vi.spyOn(w.h.adapter, 'proveDead').mockResolvedValueOnce(proof);

    expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'attempt_dead', proof });
    expect(w.items.size).toBe(0);
  });

  it('cannot touch another tenant', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const failed = await failedPayment(w, 'mine');
    const stolen = { ...failed, scope: w.h.otherScope };

    await expect(
      onTransferFailed({ payout: 'p', failed: stolen, ...OPTS }, w.deps),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });

    expect(await onChainOf(w, failed)).toBe('approved');
    expect(w.items.size).toBe(0);
    expect(w.decided.size).toBe(0);
  });

  it('gives every call a deadline', async () => {
    const w = await setup();
    const failed = await payRequest(w.h, w.m, 'timed', { total: TOTAL, fee: FEE });
    const status = vi.spyOn(w.h.adapter, 'status');
    await onTransferFailed({ payout: 'p', failed, ...OPTS }, { ...w.deps, timeoutMs: 5_000 });
    expect(status.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('a lapsed attempt still holds its funds', () => {
  // Pinned because it limits the fallback: only a cancel gives a reservation back, a
  // lapse does not, and no key UJIRA holds may cancel.
  it('so a mandate with nothing spare cannot pay the resend until someone cancels', async () => {
    const w = await setup(TOTAL + FEE);
    const { h, m } = w;
    breakFeeAddress(h);
    const { failed, input } = await lapsed(w, 'tight');
    const request = resendOf(await onTransferFailed(input, w.deps));

    const refused = await refusalOf(drive(h.adapter, request));
    expect(refused).toMatchObject({ code: 'MANDATE_RULE', specName: 'INSUFFICIENT_FUNDS' });

    await act(h, m.ref, { op: 'cancel', payoutId: failed.payoutId }, m.principal);
    expect((await drive(h.adapter, request)).at(-1)?.kind).toBe('final');
  });
});

describe('isTransferFailed', () => {
  it('knows the refusal, thrown or from a batch item, and nothing else', () => {
    const refused = new MandateRuleError(72, 'TRANSFER_FAILED');
    expect(isTransferFailed(refused)).toBe(true);
    expect(isTransferFailed(refused.toJSON())).toBe(true);
    expect(isTransferFailed({ code: 'MANDATE_RULE', specName: 'MANDATE_PAUSED' })).toBe(false);
    expect(isTransferFailed(new Error('TRANSFER_FAILED'))).toBe(false);
    expect(isTransferFailed(null)).toBe(false);
    expect(isTransferFailed('TRANSFER_FAILED')).toBe(false);
  });
});

describe('zeroFeeRequest', () => {
  it('refuses a resend that names the wrong number of legs', async () => {
    const w = await setup();
    const failed = await payRequest(w.h, w.m, 'legs', { total: TOTAL, fee: FEE });
    expect(() =>
      zeroFeeRequest(failed, {
        payoutId: 'new' as PayoutId,
        legKeys: [],
        deadline: failed.deadline,
        attestations: [],
      }),
    ).toThrow(RangeError);
  });
});
