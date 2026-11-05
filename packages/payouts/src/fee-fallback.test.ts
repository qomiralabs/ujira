// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the zero fee fallback (fee-fallback.ts), against the fake chain.
 *
 * - The fee address really cannot receive: the attempt is cancelled, and a new attempt
 *   with no fee goes out only once the old one is proven dead. The recipient is paid
 *   once and the mandate is charged the total only.
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
  SigningRequest,
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
import type { CancelSigner, FeeFallbackStore, ZeroFeeResend } from './index.js';

const OPTS = { correlationId: 'fee-fallback' };
const TOTAL = 1_000_000n;
const FEE = 5_000n;
const FUNDS = 10_000_000n;

type Harness = ReturnType<typeof fakeAdapterHarness>;

interface InvoiceItem {
  readonly scope: TenantScope;
  readonly payout: string;
  readonly fee: TokenAmount;
}

/** The one a database version must match, with a Map in place of each unique constraint. */
function memoryStore(identityOf: (resend: ZeroFeeResend) => Promise<PayRequest>) {
  const decided = new Set<string>();
  const resent = new Map<string, PayRequest>();
  const items = new Map<string, InvoiceItem>();
  const alarms = new Set<NetworkId>();
  const alerts: { network: NetworkId; reason: ReceivabilityReason }[] = [];
  const keyOf = (scope: TenantScope, id: string) => `${scope.principalId}/${scope.projectId}/${id}`;
  const store: FeeFallbackStore = {
    decideCancel: (scope, payoutId) => {
      decided.add(keyOf(scope, payoutId));
      return Promise.resolve();
    },
    cancelDecided: (scope, payoutId) => Promise.resolve(decided.has(keyOf(scope, payoutId))),
    resendWithoutFee: async (resend) => {
      const key = keyOf(resend.scope, resend.failed.payoutId);
      const existing = resent.get(key);
      if (existing !== undefined) return existing;
      const request = await identityOf(resend);
      resent.set(key, request);
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
  return { store, items, alerts, decided };
}

/** Signs as the key UJIRA holds does on the fake chain. */
const heldKey: CancelSigner = {
  sign: (request: SigningRequest) =>
    Promise.resolve(request.kind === 'stellar_transaction' ? request.xdr : null),
};

async function setup() {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h, { maxFeeBps: 50, fund: FUNDS });
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
  const deps = { adapter: h.adapter, store: memory.store, signer: heldKey };
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

async function failedPayment(
  w: Awaited<ReturnType<typeof setup>>,
  label: string,
): Promise<PayRequest> {
  const failed = await payRequest(w.h, w.m, label, { total: TOTAL, fee: FEE });
  const refusal = await refusalOf(drive(w.h.adapter, failed));
  expect(isTransferFailed(refusal)).toBe(true);
  return failed;
}

async function onChainOf(w: Awaited<ReturnType<typeof setup>>, request: PayRequest) {
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

describe('fee-fallback', () => {
  it('fee transfer failure cancels and re-requests with fee 0', async () => {
    const w = await setup();
    const { h, m, deps } = w;
    breakFeeAddress(h);
    const failed = await failedPayment(w, 'a');

    const outcome = await onTransferFailed({ payout: 'p-a', failed, ...OPTS }, deps);

    const request = resendOf(outcome);
    expect(await onChainOf(w, failed)).toBe('cancelled');
    expect(request.fee.amount).toBe(0n);
    expect(request.total).toEqual(failed.total);
    expect(request.attempt).toBe(failed.attempt + 1);
    expect(request.payoutId).not.toBe(failed.payoutId);
    expect(request.legs[0]?.legKey).not.toBe(failed.legs[0]?.legKey);
    expect(request.legs[0]?.amount).toEqual(failed.legs[0]?.amount);

    const before = await h.balance(m.ref.address);
    const recipient = m.recipients[0]?.address;
    if (recipient === undefined) throw new Error('a recipient');
    const paidBefore = await h.balance(recipient);
    expect((await drive(h.adapter, request)).at(-1)?.kind).toBe('final');
    expect(await h.balance(recipient)).toBe(paidBefore + TOTAL);
    expect(await h.balance(m.ref.address)).toBe(before - TOTAL);
    expect(await h.balance({ network: h.adapter.network, value: h.world.net.feeAddress })).toBe(0n);
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
    const failed = await failedPayment(w, 'once');
    const input = { payout: 'p-once', failed, ...OPTS };

    const first = resendOf(await onTransferFailed(input, w.deps));
    const again = resendOf(await onTransferFailed(input, w.deps));

    expect(again).toEqual(first);
    expect([...w.items.values()]).toEqual([
      { scope: w.h.scope, payout: 'p-once', fee: failed.fee },
    ]);
  });

  it('keeps invoice items apart per payout', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const one = await failedPayment(w, 'one');
    const two = await failedPayment(w, 'two');
    await onTransferFailed({ payout: 'p-one', failed: one, ...OPTS }, w.deps);
    await onTransferFailed({ payout: 'p-two', failed: two, ...OPTS }, w.deps);
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
    fixFeeAddress(h);
    expect((await drive(h.adapter, failed)).at(-1)?.kind).toBe('final');
    breakFeeAddress(h);

    expect(await onTransferFailed({ payout: 'p', failed, ...OPTS }, w.deps)).toEqual({
      kind: 'already_landed',
    });
    expect(w.items.size).toBe(0);
  });

  it('does not bring back a payout the principal cancelled', async () => {
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
    const failed = await failedPayment(w, 'killed');
    const killed = new Error('worker killed');
    const spy = vi.spyOn(w.store, 'resendWithoutFee').mockRejectedValueOnce(killed);
    const input = { payout: 'p', failed, ...OPTS };

    await expect(onTransferFailed(input, w.deps)).rejects.toBe(killed);
    spy.mockRestore();
    expect(await onChainOf(w, failed)).toBe('cancelled');
    expect(w.items.size).toBe(0);

    fixFeeAddress(h);
    const request = resendOf(await onTransferFailed(input, w.deps));
    expect(request.fee.amount).toBe(0n);
    expect(w.items.size).toBe(1);
  });

  it('a job killed before the cancel lands sends it on the rerun', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const failed = await failedPayment(w, 'before-cancel');
    const killed = new Error('worker killed');
    const spy = vi.spyOn(w.h.adapter, 'submitSigned').mockRejectedValueOnce(killed);
    const input = { payout: 'p', failed, ...OPTS };

    await expect(onTransferFailed(input, w.deps)).rejects.toBe(killed);
    spy.mockRestore();
    expect(await onChainOf(w, failed)).toBe('approved');

    resendOf(await onTransferFailed(input, w.deps));
    expect(await onChainOf(w, failed)).toBe('cancelled');
  });

  it('waits for the cancel to be final, and does not send it twice', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const failed = await failedPayment(w, 'slow');
    const input = { payout: 'p', failed, ...OPTS };
    const prove = vi.spyOn(w.h.adapter, 'proveDead');
    // The first read is before the decision, the second after the cancel.
    prove.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'cancel_pending' });
    expect(w.items.size).toBe(0);

    prove.mockResolvedValueOnce(null);
    const submit = vi.spyOn(w.h.adapter, 'submitSigned');
    expect(await onTransferFailed(input, w.deps)).toEqual({ kind: 'cancel_pending' });
    expect(submit).not.toHaveBeenCalled();

    resendOf(await onTransferFailed(input, w.deps));
    expect(submit).not.toHaveBeenCalled();
    expect(w.items.size).toBe(1);
  });

  it('asks the wallet when only the wallet can cancel, then finishes on the rerun', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const failed = await failedPayment(w, 'wallet');
    const input = { payout: 'p', failed, ...OPTS };
    const unheld = { ...w.deps, signer: { sign: () => Promise.resolve(null) } };

    const outcome = await onTransferFailed(input, unheld);
    expect(outcome).toMatchObject({ kind: 'signature_required' });
    expect(await onChainOf(w, failed)).toBe('approved');
    expect(w.items.size).toBe(0);

    resendOf(await onTransferFailed(input, w.deps));
    expect(w.items.size).toBe(1);
  });

  it('leaves it to the approver when a rejection beat the cancel', async () => {
    const w = await setup();
    breakFeeAddress(w.h);
    const failed = await failedPayment(w, 'rejected');
    await w.store.decideCancel(failed.scope, failed.payoutId, {
      signal: AbortSignal.timeout(1000),
    });
    const proof = {
      kind: 'tombstone',
      network: w.h.adapter.network,
      status: 'rejected',
      at: { ledgerOrBlock: 1n, finality: 'final' },
    } as const;
    vi.spyOn(w.h.adapter, 'proveDead').mockResolvedValueOnce(proof);

    expect(await onTransferFailed({ payout: 'p', failed, ...OPTS }, w.deps)).toEqual({
      kind: 'attempt_dead',
      proof,
    });
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
