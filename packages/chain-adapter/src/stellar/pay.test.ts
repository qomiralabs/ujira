// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Address, Keypair, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { encodeMuxedAddress, decodeAccountAddress } from '../codecs/strkey.js';
import { ChainUnavailableError, InternalError } from '../errors.js';
import { feeCap } from '../fee-cap.js';
import { formatReceiptRef } from '../receipt-ref.js';
import type { Bytes32, LegKey, PayStep, UnixSeconds } from '../types.js';
import { readDestination } from './destination-check.js';
import {
  asVec,
  bytes32,
  destination,
  field,
  fieldsOf,
  i128,
  struct,
  sym,
  u32,
  vec,
} from './scval.js';
import { NETWORK, OPTS, addAccount } from './test-adapter.js';
import {
  METHOD,
  TOTAL,
  executedEvent,
  payRequest,
  payWorld,
  payoutIdOf,
  record,
  refusal,
  tombstone,
  trustline,
} from './test-payouts.js';
import type { PayWorld } from './test-payouts.js';
import { FIXTURE_APPROVER, invoked } from './test-rpc.js';
import { instanceKey } from './trust.js';
import { PASSPHRASES } from './tx.js';

/** An approval the recorded mandate would count: its one approver, at its stored epoch. */
const LIVE_APPROVAL = { approver: FIXTURE_APPROVER, epoch: 0 };
const removedApproval = () => ({ approver: Keypair.random().publicKey(), epoch: 0 });

/** The recorded mandate, with no roles where the adapter looks for them. */
function dropStoredRoles(w: PayWorld): void {
  const key = instanceKey(w.mandate.address.value).toXdr('base64');
  const entry = w.rpc.entries.get(key);
  if (entry === undefined) throw new Error('no instance entry');
  const data = xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64');
  if (data.type !== 'contractData' || data.contractData.val.type !== 'scvContractInstance') {
    throw new Error('not an instance');
  }
  const { contractData } = data;
  const { instance } = contractData.val as xdr.ScVal & { type: 'scvContractInstance' };
  const roles = vec([sym('Roles')]).toXdr('base64');
  const kept = (instance.storage ?? []).filter((e) => e.key.toXdr('base64') !== roles);
  expect(kept).toHaveLength((instance.storage ?? []).length - 1);
  w.rpc.entries.set(key, {
    ...entry,
    xdr: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: contractData.ext,
        contract: contractData.contract,
        key: contractData.key,
        durability: contractData.durability,
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({ executable: instance.executable, storage: kept }),
        ),
      }),
    ).toXdr('base64'),
  });
}

function refuseAs(w: PayWorld, name: 'AGENT_REMOVED') {
  return refusal(w.mandate.address.value, name);
}

function itemResults(payoutId: string, code = 0) {
  return vec([
    struct({
      payout_id: bytes32('id', payoutId as Bytes32),
      code: u32('code', code),
      status: xdr.ScVal.scvVoid(),
    }),
  ]);
}

const leg = (address: string, tag: bigint | null = null) =>
  struct({
    destination: destination('d', { address: { network: NETWORK, value: address }, tag }),
    amount: i128('a', TOTAL),
  });

function called(w: PayWorld, fn: string): Transaction[] {
  return w.rpc.simulated.filter(
    (tx) => tx.operations[0]?.type === 'invokeHostFunction' && invoked(tx).fn === fn,
  );
}

describe('the pay step', { timeout: 30_000 }, () => {
  it('requests a payout as the agent, with the sponsor paying in a fee bump', async () => {
    const w = payWorld();
    const req = payRequest(w);
    const step = await w.payouts.pay(req, OPTS);
    expect(step).toMatchObject({ kind: 'submitted', op: 'request' });
    expect(w.rpc.sent).toHaveLength(1);
    const [record0] = [...w.store.submissions.values()];
    expect(record0).toMatchObject({ op: 'request', payoutId: req.payoutId, attempt: 1 });
    expect(record0?.signerAddress).toBe(w.agent.publicKey());
    expect(w.sponsorship.calls.map((c) => c.kind)).toEqual(['reserve']);
    const [sent] = w.rpc.sent;
    if (sent === undefined) throw new Error('nothing sent');
    expect(TransactionBuilder.fromXdr(sent, PASSPHRASES[NETWORK])).toHaveProperty(
      'innerTransaction',
    );
    // No lease: an executor key may only ever sign an execute.
    expect(w.store.releases).toEqual([]);
    const [only] = req.legs;
    if (only === undefined) throw new Error('no leg');
    expect(await w.store.liveDelivery(w.scope, only.legKey)).toMatchObject({
      provider: 'wallet',
      state: 'not_applicable',
    });
  });

  it('performs one step per call, and waits on what it already sent', async () => {
    const w = payWorld();
    const req = payRequest(w);
    const first = await w.payouts.pay(req, OPTS);
    if (first.kind !== 'submitted') throw new Error('expected submitted');
    w.rpc.txs.set(first.submission.txHash, {
      status: 'NOT_FOUND',
      latestLedgerCloseTime: w.rpc.latest.closeTime,
    });
    expect(await w.payouts.pay(req, OPTS)).toEqual(first);
    expect(w.rpc.sent).toHaveLength(1);
  });

  it('goes on once the request landed, from what the mandate says', async () => {
    const w = payWorld();
    const req = payRequest(w);
    const first = await w.payouts.pay(req, OPTS);
    if (first.kind !== 'submitted') throw new Error('expected submitted');
    w.rpc.txs.set(first.submission.txHash, { status: 'SUCCESS', ledger: 7 });
    w.views.set(req.payoutId, record(2));
    expect(await w.payouts.pay(req, OPTS)).toMatchObject({ kind: 'submitted', op: 'execute' });
    expect(w.rpc.sent).toHaveLength(2);
  });

  it('builds nothing new while what it sent cannot be accounted for', async () => {
    const w = payWorld();
    const req = payRequest(w);
    const first = await w.payouts.pay(req, OPTS);
    if (first.kind !== 'submitted') throw new Error('expected submitted');
    // Past its window, with the RPC's retention not reaching the send.
    w.rpc.txs.set(first.submission.txHash, {
      status: 'NOT_FOUND',
      latestLedgerCloseTime: w.rpc.latest.closeTime + 100_000n,
      oldestLedger: w.rpc.latest.sequence + 1,
    });
    expect(await w.payouts.pay(req, OPTS)).toMatchObject({ kind: 'submitted', op: 'request' });
    expect(w.rpc.sent).toHaveLength(1);
  });

  it('asks an agent with its own wallet to sign instead of sending', async () => {
    const w = payWorld();
    const wallet = Keypair.random();
    addAccount(w.rpc, wallet.publicKey(), 5n);
    const step = await w.payouts.pay(
      payRequest(w, 1, {
        signer: {
          kind: 'external',
          network: NETWORK,
          role: 'agent',
          address: { network: NETWORK, value: wallet.publicKey() },
        } as never,
      }),
      OPTS,
    );
    expect(step).toMatchObject({
      kind: 'signature_required',
      request: { kind: 'stellar_transaction', summary: { action: 'request_payout' } },
    });
    expect(w.rpc.sent).toEqual([]);
  });

  it('passes a tagged destination to the mandate as a muxed address', async () => {
    const w = payWorld();
    w.methods.set(METHOD, { address: { network: NETWORK, value: w.recipient }, tag: 42n });
    await w.payouts.pay(payRequest(w), OPTS);
    const [tx] = called(w, 'request_payout');
    if (tx === undefined) throw new Error('no request');
    const request = invoked(tx).args[1];
    if (request === undefined) throw new Error('no request');
    const [first] = asVec(field(fieldsOf(request), 'legs'));
    if (first === undefined) throw new Error('no leg');
    const to = field(fieldsOf(first), 'destination');
    if (to.type !== 'scvAddress') throw new Error('not an address');
    expect(Address.fromScAddress(to.address).toString()).toBe(
      encodeMuxedAddress(decodeAccountAddress(w.recipient), 42n),
    );
  });

  describe('prechecks, before any request', () => {
    async function refusedBefore(w: PayWorld, code: string) {
      await expect(w.payouts.pay(payRequest(w), OPTS)).rejects.toMatchObject({ code });
      expect(called(w, 'request_payout')).toEqual([]);
      expect(w.rpc.sent).toEqual([]);
    }

    it('destination without trustline gives DESTINATION_INVALID', async () => {
      const w = payWorld();
      w.methods.set(METHOD, {
        address: { network: NETWORK, value: Keypair.random().publicKey() },
        tag: null,
      });
      await refusedBefore(w, 'DESTINATION_INVALID');
      const bare = payWorld();
      const account = Keypair.random().publicKey();
      addAccount(bare.rpc, account, 1n);
      bare.methods.set(METHOD, { address: { network: NETWORK, value: account }, tag: null });
      await refusedBefore(bare, 'DESTINATION_INVALID');
    });

    // Already refused by the destination read. Pinned, because a transfer here burns.
    it('a leg to the asset issuer gives DESTINATION_INVALID, under a tag as well', async () => {
      const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const w = payWorld();
      w.methods.set(METHOD, { address: { network: NETWORK, value: issuer }, tag: null });
      await refusedBefore(w, 'DESTINATION_INVALID');
      const tagged = payWorld();
      tagged.methods.set(METHOD, { address: { network: NETWORK, value: issuer }, tag: 7n });
      await refusedBefore(tagged, 'DESTINATION_INVALID');
      const muxed = payWorld();
      muxed.methods.set(METHOD, {
        address: {
          network: NETWORK,
          value: encodeMuxedAddress(decodeAccountAddress(issuer), 7n),
        },
        tag: null,
      });
      await refusedBefore(muxed, 'DESTINATION_INVALID');
    });

    it('maintain-only trustline', async () => {
      const w = payWorld();
      trustline(w, w.recipient, { flags: 2 });
      await refusedBefore(w, 'DESTINATION_INVALID');
    });

    it('limit headroom below the leg amount', async () => {
      const w = payWorld();
      trustline(w, w.recipient, { limit: TOTAL + 5n, balance: 6n });
      await refusedBefore(w, 'DESTINATION_INVALID');
      const exact = payWorld();
      trustline(exact, exact.recipient, { limit: TOTAL + 5n, balance: 5n });
      expect(await exact.payouts.pay(payRequest(exact), OPTS)).toMatchObject({ kind: 'submitted' });
    });

    it('fee one unit over the cap gives FEE_EXCEEDS_CAP with zero submissions', async () => {
      const w = payWorld();
      const snapshot = await w.adapter.readMandate({ scope: w.scope, mandate: w.mandate }, OPTS);
      const cap = feeCap(TOTAL, snapshot.config.maxFeeBps);
      await expect(
        w.payouts.pay(payRequest(w, 1, { fee: tokenAmount(cap + 1n, 'USDC', 'stellar') }), OPTS),
      ).rejects.toMatchObject({ specName: 'FEE_EXCEEDS_CAP', landed: 'no' });
      expect(w.rpc.sent).toEqual([]);
      expect(called(w, 'request_payout')).toEqual([]);
      expect(
        await w.payouts.pay(payRequest(w, 2, { fee: tokenAmount(cap, 'USDC', 'stellar') }), OPTS),
      ).toMatchObject({ kind: 'submitted' });
    });

    it('a lowered cap stops an execution before it is sent', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, record(2, { fee: TOTAL }));
      await expect(w.payouts.pay(req, OPTS)).rejects.toMatchObject({ specName: 'FEE_EXCEEDS_CAP' });
      expect(w.rpc.sent).toEqual([]);
    });

    it('a rail other than the wallet is not this step', async () => {
      const w = payWorld();
      const req = payRequest(w);
      const [first] = req.legs;
      if (first === undefined) throw new Error('no leg');
      await expect(
        w.payouts.pay({ ...req, legs: [{ ...first, rail: 'stellar.sep31' }] }, OPTS),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    });

    it('a method it cannot find is refused, never guessed', async () => {
      const w = payWorld();
      w.methods.clear();
      await expect(w.payouts.pay(payRequest(w), OPTS)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    it.each<[string, (w: PayWorld) => ReturnType<typeof payRequest>]>([
      ['a zero total', (w) => payRequest(w, 1, { total: tokenAmount(0n, 'USDC', 'stellar') })],
      ['a negative fee', (w) => payRequest(w, 1, { fee: tokenAmount(-1n, 'USDC', 'stellar') })],
      ['an attempt of zero', (w) => payRequest(w, 1, { attempt: 0 })],
      ['no legs', (w) => payRequest(w, 1, { legs: [] })],
      [
        'legs that do not sum to the total',
        (w) => payRequest(w, 1, { total: tokenAmount(5n, 'USDC', 'stellar') }),
      ],
      [
        'a leg key of another payout',
        (w) => {
          const req = payRequest(w);
          const [first] = req.legs;
          if (first === undefined) throw new Error('no leg');
          return { ...req, legs: [{ ...first, legKey: 'nope' as LegKey }] };
        },
      ],
      [
        'a repeated leg index',
        (w) => {
          const req = payRequest(w);
          const [first] = req.legs;
          if (first === undefined) throw new Error('no leg');
          return { ...req, legs: [first, first] };
        },
      ],
    ])('refuses %s', async (_name, build) => {
      const w = payWorld();
      await expect(w.payouts.pay(build(w), OPTS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('from what the mandate holds', () => {
    it('waits for approvals on a pending payout', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, record(1, { approvals: [LIVE_APPROVAL] }));
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({
        kind: 'awaiting_approval',
        approvals: { count: 1 },
      });
    });

    // The mandate voids an approval along with its approver's seat, so a list that still
    // holds it does not mean what it looks like: this payout cannot execute.
    it('does not count an approval from an approver since removed', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, record(1, { approvals: [LIVE_APPROVAL, removedApproval()] }));
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({ approvals: { count: 1 } });
      w.views.set(req.payoutId, record(1, { approvals: [removedApproval()] }));
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({ approvals: { count: 0 } });
    });

    // Adding an approver back gives them a new epoch, and what they approved under the old
    // one stays void. The address alone would count it.
    it('does not count an approval given under an approver epoch that has passed', async () => {
      const w = payWorld();
      const req = payRequest(w);
      const stale = { approver: FIXTURE_APPROVER, epoch: LIVE_APPROVAL.epoch + 1 };
      w.views.set(req.payoutId, record(1, { approvals: [stale] }));
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({ approvals: { count: 0 } });
    });

    // This reads the mandate's storage, which is no public interface. The fixture is
    // recorded from the deployed contract, so a change there fails here once re-recorded.
    it('counts against the approvers the recorded testnet mandate stores', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, record(1, { approvals: [LIVE_APPROVAL] }));
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({ approvals: { count: 1 } });
      dropStoredRoles(w);
      await expect(w.payouts.pay(req, OPTS)).rejects.toBeInstanceOf(InternalError);
    });

    it('reads no storage for a payout nobody has approved', async () => {
      const w = payWorld();
      const req = payRequest(w);
      dropStoredRoles(w);
      w.views.set(req.payoutId, record(1));
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({ approvals: { count: 0 } });
    });

    it('holds an approved payout that was asked to hold', async () => {
      const w = payWorld();
      const req = payRequest(w, 1, { execute: 'hold' });
      w.views.set(req.payoutId, record(2));
      expect(await w.payouts.pay(req, OPTS)).toEqual<PayStep>({ kind: 'held' });
    });

    it('refuses an ID the mandate holds for another amount', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, record(2, { total: TOTAL + 1n }));
      await expect(w.payouts.pay(req, OPTS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('stops at a lapsed payout', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, record(2, { expiresAt: 1n }));
      await expect(w.payouts.pay(req, OPTS)).rejects.toMatchObject({
        specName: 'PAYOUT_LAPSED',
        retryable: false,
      });
    });

    it('AGENT_REMOVED marks the attempt dead and alerts', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, record(2));
      w.refused.set('execute', 'AGENT_REMOVED');
      await expect(w.payouts.pay(req, OPTS)).rejects.toMatchObject({
        specName: 'AGENT_REMOVED',
        retryable: false,
        waitFor: 'none',
      });
      expect(w.rpc.sent).toEqual([]);
      expect(w.alerts).toEqual([
        {
          network: NETWORK,
          kind: 'agent_removed',
          scope: w.scope,
          payoutId: req.payoutId,
          correlationId: OPTS.correlationId,
        },
      ]);
    });

    it('raises no removal alert for any other refusal', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, record(2));
      w.refused.set('execute', 'INSUFFICIENT_FUNDS');
      await expect(w.payouts.pay(req, OPTS)).rejects.toMatchObject({
        specName: 'INSUFFICIENT_FUNDS',
      });
      expect(w.alerts).toEqual([]);
    });

    describe('cancelling a lapsed payout', () => {
      const request = (req: ReturnType<typeof payRequest>) => ({
        scope: req.scope,
        mandate: req.mandate,
        payoutId: req.payoutId,
      });

      it('sends a cancel as the executor once the payout has lapsed', async () => {
        const w = payWorld();
        const req = payRequest(w);
        w.views.set(req.payoutId, record(2, { expiresAt: 1n }));
        const step = await w.payouts.cancelLapsed(request(req), OPTS);
        expect(step.kind).toBe('submitted');
        expect(called(w, 'cancel').length).toBeGreaterThan(0);
        expect(w.rpc.sent.length).toBe(1);
      });

      it('sends nothing before then', async () => {
        const w = payWorld();
        const req = payRequest(w);
        w.views.set(req.payoutId, record(2));
        expect(await w.payouts.cancelLapsed(request(req), OPTS)).toEqual({ kind: 'not_lapsed' });
        expect(called(w, 'cancel')).toEqual([]);
        expect(w.rpc.sent).toEqual([]);
      });

      it('reports one already cancelled, and one never recorded', async () => {
        const w = payWorld();
        const req = payRequest(w);
        expect(await w.payouts.cancelLapsed(request(req), OPTS)).toEqual({ kind: 'absent' });
        w.views.set(req.payoutId, tombstone(5));
        expect(await w.payouts.cancelLapsed(request(req), OPTS)).toEqual({
          kind: 'cancelled',
          final: true,
        });
        expect(w.rpc.sent).toEqual([]);
      });
    });

    it('reports a closed payout as dead, with its status', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, tombstone(5));
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({
        kind: 'dead',
        proof: { kind: 'tombstone', status: 'cancelled' },
      });
    });

    it('proves an absent payout dead once its deadline passed', async () => {
      const w = payWorld();
      const req = payRequest(w, 1, { deadline: w.rpc.latest.closeTime as UnixSeconds });
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({
        kind: 'dead',
        proof: { kind: 'deadline_passed' },
      });
      expect(w.rpc.sent).toEqual([]);
    });

    it('reports an executed payout final, with a receipt from its event', async () => {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, tombstone(3));
      w.rpc.getEvents = () =>
        Promise.resolve({
          events: [executedEvent(w.mandate.address.value, req.payoutId, [leg(w.recipient)])],
          cursor: null,
          latestLedger: 200,
        });
      expect(await w.payouts.pay(req, OPTS)).toMatchObject({
        kind: 'final',
        receipt: {
          txHash: 'ab'.repeat(32),
          eventIndex: 3,
          finality: 'final',
          total: { amount: TOTAL },
          legs: [{ index: 0, amount: { amount: TOTAL } }],
        },
      });
    });
  });
});

describe('the receipt', { timeout: 30_000 }, () => {
  const id = payoutIdOf(1);

  function withEvents(w: PayWorld, events: Parameters<typeof executedEvent>[2], over = {}) {
    w.rpc.getEvents = () =>
      Promise.resolve({
        events: [executedEvent(w.mandate.address.value, id, events, over)],
        cursor: null,
        latestLedger: 200,
      });
  }

  it('reads a tagged leg back as its address and tag, with the network fee', async () => {
    const w = payWorld();
    withEvents(w, [leg(w.recipient, 42n)]);
    const receipt = await w.payouts.receipt(
      { scope: w.scope, mandate: w.mandate, payoutId: id },
      OPTS,
    );
    expect(receipt.legs[0]).toMatchObject({ destination: { value: w.recipient }, tag: 42n });
    expect(receipt.explorerUrl).toContain('ab'.repeat(32));
    expect(receipt.networkFee).toMatchObject({ asset: 'XLM', scale: 7 });
  });

  it.each([
    [
      'another contract',
      { contractId: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526' },
    ],
    ['a failed call', { inSuccessfulContractCall: false }],
    ['a diagnostic event', { type: 'diagnostic' }],
  ])('does not take the node at its word about %s', async (_name, over) => {
    const w = payWorld();
    withEvents(w, [leg(w.recipient)], over);
    await expect(
      w.payouts.receipt({ scope: w.scope, mandate: w.mandate, payoutId: id }, OPTS),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('falls back to the indexer copy outside the RPC window', async () => {
    const w = payWorld({
      mirror: {
        executed: () =>
          Promise.resolve({
            txHash: 'cd'.repeat(32),
            eventIndex: 1,
            ledger: 5n,
            closedAt: '2026-01-01T00:00:00Z',
            fields: { total: TOTAL.toString(), legs: [] },
            feeCharged: 77n,
          }),
      },
    });
    w.rpc.getEvents = () => Promise.reject(new ChainUnavailableError({ network: NETWORK }));
    const receipt = await w.payouts.receipt(
      { scope: w.scope, mandate: w.mandate, payoutId: id },
      OPTS,
    );
    expect(receipt).toMatchObject({ txHash: 'cd'.repeat(32), networkFee: { amount: 77n } });
  });

  it('verifies a reference against the chain', async () => {
    const w = payWorld();
    const ref = formatReceiptRef({ network: NETWORK, txHash: 'ab'.repeat(32), eventIndex: 3 });
    withEvents(w, [leg(w.recipient)]);
    w.rpc.txs.set('ab'.repeat(32), { status: 'SUCCESS', ledger: 123 });
    expect(await w.payouts.verifyReceipt(ref, OPTS)).toMatchObject({
      ok: true,
      receipt: { payoutId: id, mandate: { address: { value: w.mandate.address.value } } },
    });
    w.rpc.txs.set('ab'.repeat(32), { status: 'FAILED', ledger: 123 });
    expect(await w.payouts.verifyReceipt(ref, OPTS)).toEqual({ ok: false, reason: 'mismatch' });
    w.rpc.txs.set('ab'.repeat(32), { status: 'NOT_FOUND' });
    expect(await w.payouts.verifyReceipt(ref, OPTS)).toEqual({
      ok: false,
      reason: 'outside_rpc_retention',
    });
    w.rpc.txs.set('ab'.repeat(32), { status: 'SUCCESS', ledger: 123 });
    const wrong = formatReceiptRef({ network: NETWORK, txHash: 'ab'.repeat(32), eventIndex: 9 });
    expect(await w.payouts.verifyReceipt(wrong, OPTS)).toEqual({ ok: false, reason: 'mismatch' });
    const pubnet = formatReceiptRef({
      network: 'stellar:pubnet',
      txHash: 'ab'.repeat(32),
      eventIndex: 3,
    });
    expect(await w.payouts.verifyReceipt(pubnet, OPTS)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('status', { timeout: 30_000 }, () => {
  const request = (w: PayWorld) => {
    const req = payRequest(w);
    return {
      scope: w.scope,
      mandate: w.mandate,
      payoutId: req.payoutId,
      legs: req.legs.map((l) => l.legKey),
    };
  };

  it('reports each state the mandate can hold', async () => {
    const w = payWorld();
    expect(await w.payouts.status(request(w), OPTS)).toMatchObject({
      onChain: 'absent',
      finality: 'none',
      lapsed: false,
      legs: [],
    });
    await w.payouts.pay(payRequest(w), OPTS);
    const id = payRequest(w).payoutId as unknown as string;
    w.views.set(id, record(1, { approvals: [LIVE_APPROVAL, removedApproval()] }));
    expect(await w.payouts.status(request(w), OPTS)).toMatchObject({
      onChain: 'pending',
      approvals: { count: 1 },
      legs: [{ rail: 'stellar.wallet', state: 'not_applicable' }],
    });
    w.views.set(id, record(2, { expiresAt: 1n }));
    expect(await w.payouts.status(request(w), OPTS)).toMatchObject({
      onChain: 'approved',
      lapsed: true,
    });
    w.views.set(id, tombstone(4));
    expect(await w.payouts.status(request(w), OPTS)).toMatchObject({ onChain: 'rejected' });
    w.views.set(id, tombstone(3));
    w.rpc.getEvents = () =>
      Promise.resolve({
        events: [executedEvent(w.mandate.address.value, payoutIdOf(1), [leg(w.recipient)])],
        cursor: null,
        latestLedger: 200,
      });
    const executed = await w.payouts.status(request(w), OPTS);
    expect(executed).toMatchObject({ onChain: 'executed', finality: 'final' });
    expect(executed.receipt).toMatch(/^ujira:tx:v1:/);
  });
});

describe('batches', { timeout: 30_000 }, () => {
  const batch = (w: PayWorld, items: ReturnType<typeof payRequest>[]) =>
    w.payouts.payBatch({ scope: w.scope, mandate: w.mandate, items }, OPTS);

  it('refuses a batch of the wrong shape', async () => {
    const w = payWorld();
    await expect(batch(w, [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const one = payRequest(w);
    await expect(batch(w, [one, one])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const other = { ...w.scope, projectId: '00000000-0000-4000-8000-000000000099' };
    await expect(batch(w, [{ ...one, scope: other as typeof w.scope }])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const eleven = Array.from({ length: 11 }, (_, i) => payRequest(w, i + 1));
    await expect(batch(w, eleven)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('executes what is approved in one transaction and leaves out what the mandate refuses', async () => {
    const w = payWorld();
    const [a, b] = [payRequest(w, 1), payRequest(w, 2)];
    w.views.set(a.payoutId, record(2));
    w.views.set(b.payoutId, record(2));
    // The whole batch fails on its second item; a prefix of one passes.
    w.refused.set('execute_batch', (tx) => {
      const ids = invoked(tx).args[1];
      const size = ids?.type === 'scvVec' ? (ids.vec ?? []).length : 0;
      return size > 1 ? refuseAs(w, 'AGENT_REMOVED') : undefined;
    });
    const step = await batch(w, [a, b]);
    expect(step.submissions).toHaveLength(1);
    expect(step.items.map((i) => i.step.kind)).toEqual(['submitted', 'item_failed']);
    expect(w.alerts).toMatchObject([{ kind: 'agent_removed', payoutId: b.payoutId }]);
  });

  it('holds what was asked to hold', async () => {
    const w = payWorld();
    const held = payRequest(w, 1, { execute: 'hold' });
    w.views.set(held.payoutId, record(2));
    const step = await batch(w, [held]);
    expect(step.items[0]?.step).toEqual({ kind: 'held' });
    expect(step.submissions).toEqual([]);
  });

  it('marks an over-cap item failed and requests the rest', async () => {
    const w = payWorld();
    const over = payRequest(w, 1, { fee: tokenAmount(TOTAL, 'USDC', 'stellar') });
    const fine = payRequest(w, 2);
    w.refused.set('request_payouts', (tx) =>
      w.rpc.success(tx, itemResults(fine.payoutId), w.rpc.authFor(tx)),
    );
    const step = await batch(w, [over, fine]);
    expect(step.items.map((i) => i.step.kind)).toEqual(['item_failed', 'submitted']);
    expect(step.submissions).toHaveLength(1);
  });

  it('marks an item the mandate refuses, and sends nothing when none is left', async () => {
    const w = payWorld();
    const only = payRequest(w, 1);
    w.refused.set('request_payouts', (tx) =>
      w.rpc.success(tx, itemResults(only.payoutId, 23), w.rpc.authFor(tx)),
    );
    const step = await batch(w, [only]);
    expect(step.items[0]?.step).toMatchObject({
      kind: 'item_failed',
      error: { specName: 'ALREADY_PAUSED' },
    });
    expect(w.rpc.sent).toEqual([]);
  });

  it('reports an item it sends nothing for without sending it, and keeps a failure to that item', async () => {
    const w = payWorld();
    const lapsed = payRequest(w, 1);
    const pending = payRequest(w, 2);
    const cancelled = payRequest(w, 3);
    const executed = payRequest(w, 4);
    const fine = payRequest(w, 5);
    const late = payRequest(w, 6, { deadline: w.rpc.latest.closeTime as UnixSeconds });
    w.views.set(lapsed.payoutId, record(2, { expiresAt: 1n }));
    w.views.set(pending.payoutId, record(1));
    w.views.set(cancelled.payoutId, tombstone(5));
    // Nothing to read its receipt from, which fails this item and no other.
    w.views.set(executed.payoutId, tombstone(3));
    w.views.set(fine.payoutId, record(2));
    const step = await batch(w, [lapsed, pending, cancelled, executed, fine, late]);
    expect(step.items.map((i) => i.step.kind)).toEqual([
      'held',
      'awaiting_approval',
      'dead',
      'item_failed',
      'submitted',
      'dead',
    ]);
    expect(step.submissions).toHaveLength(1);
    expect(w.rpc.sent).toHaveLength(1);
  });

  it('counts only live approvals on a pending item in a batch too', async () => {
    const w = payWorld();
    const pending = payRequest(w, 1);
    const fine = payRequest(w, 2);
    w.views.set(pending.payoutId, record(1, { approvals: [LIVE_APPROVAL, removedApproval()] }));
    w.views.set(fine.payoutId, record(2));
    const step = await batch(w, [pending, fine]);
    expect(step.items[0]?.step).toMatchObject({
      kind: 'awaiting_approval',
      approvals: { count: 1 },
    });
  });

  it('refuses a request batch with mixed signers', async () => {
    const w = payWorld();
    const external = {
      kind: 'external',
      network: NETWORK,
      role: 'agent',
      address: { network: NETWORK, value: Keypair.random().publicKey() },
    } as never;
    await expect(
      batch(w, [payRequest(w, 1), payRequest(w, 2, { signer: external })]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('checkDestination', { timeout: 30_000 }, () => {
  const issuer = (w: PayWorld) => w.ports.config()[NETWORK]?.assets.USDC.issuer ?? '';
  const to = (value: string) => ({ address: { network: NETWORK, value }, tag: null });

  it('takes a contract as able to receive', async () => {
    const w = payWorld();
    expect(
      await w.payouts.checkDestination({ destination: to(w.mandate.address.value) }, OPTS),
    ).toEqual({
      receivable: true,
      proofSigner: 'not_applicable',
    });
  });

  it('refuses the issuer, which cannot hold its own asset', async () => {
    const w = payWorld();
    expect(
      await readDestination(w.rpc, issuer(w), { destination: to(issuer(w)) }, OPTS),
    ).toMatchObject({
      receivable: false,
      reason: 'DESTINATION_IS_ISSUER',
    });
  });

  it('says whether the proof signer still signs', async () => {
    const w = payWorld();
    const req = { destination: to(w.recipient) };
    expect(await w.payouts.checkDestination(req, OPTS)).toEqual({
      receivable: true,
      proofSigner: 'not_applicable',
    });
    expect(
      await w.payouts.checkDestination({ ...req, proofSigner: w.recipient }, OPTS),
    ).toMatchObject({ proofSigner: 'current' });
    expect(
      await w.payouts.checkDestination({ ...req, proofSigner: Keypair.random().publicKey() }, OPTS),
    ).toMatchObject({ proofSigner: 'not_current' });
  });

  it('checks the limit only when given an amount', async () => {
    const w = payWorld();
    trustline(w, w.recipient, { limit: 10n, balance: 10n });
    const req = { destination: to(w.recipient) };
    expect(await w.payouts.checkDestination(req, OPTS)).toMatchObject({ receivable: true });
    expect(
      await w.payouts.checkDestination({ ...req, amount: { amount: 1n } }, OPTS),
    ).toMatchObject({ receivable: false, reason: 'TRUSTLINE_LIMIT' });
  });
});
