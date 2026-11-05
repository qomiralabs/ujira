// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fake's less travelled paths: every mandate action reaching the chain,
// leases taken over mid step, stranded and replayed submissions, deposits
// in other assets, and the fake network's own guards.

import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import type {
  AdapterStore,
  CallOptions,
  ChainAddress,
  ExecutorLease,
  MandateAction,
  PayRequest,
  ReceiptRef,
  SigningRequest,
  TenantScope,
  Uuid,
} from '../types.js';

import {
  FakeChainAdapter,
  FakeNetwork,
  FakeSigner,
  act,
  deployMandate,
  drive,
  fakeAdapterHarness,
  finalReceipt,
  must,
  payRequest,
  refusalOf,
  signFakeRequest,
} from './index.js';

const OPTS: CallOptions = { correlationId: 'edges' };
const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', 'stellar');

async function world(options: Parameters<typeof fakeAdapterHarness>[0] = {}) {
  const h = fakeAdapterHarness(options);
  const m = await deployMandate(h, { approvers: 1 });
  return { h, m, net: h.world.net };
}

describe('every mandate action', () => {
  it('reaches the chain through the adapter', async () => {
    const { h, m, net } = await world();
    const recipient = must(m.recipients[0], 'a recipient');
    const held = await payRequest(h, m, 'actions', { execute: 'hold' });
    await drive(h.adapter, held);
    const heir = h.wallet('heir');
    const ran = async (
      action: MandateAction,
      wallet = m.principal,
      role: 'principal' | 'approver' = 'principal',
    ) => {
      const outcome = await act(h, m.ref, action, wallet, role).then(
        () => 'ok',
        (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
      );
      return outcome;
    };
    const limits = (await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS)).config
      .limits;
    const entry = {
      recipientRef: recipient.recipientRef,
      destination: { address: recipient.address, tag: null },
    };
    expect(await ran({ op: 'update_limits', limits })).toBe('ok');
    expect(await ran({ op: 'set_approvals_required', n: 1 })).toBe('ok');
    expect(await ran({ op: 'add_role', role: 'guardian', account: heir })).toBe('ok');
    expect(await ran({ op: 'remove_role', role: 'guardian', account: heir })).toBe('ok');
    expect(await ran({ op: 'cancel_batch', payoutIds: [held.payoutId] })).toBe('ok');
    expect(await ran({ op: 'disallow_recipients', entries: [entry] })).toBe('ok');
    expect(await ran({ op: 'allow_recipients', entries: [entry] })).toBe('ok');
    const policy = {
      op: 'set_attestation_policy' as const,
      attester: new Uint8Array(32).fill(7),
      countryPolicyHash: `0x${'11'.repeat(32)}` as never,
    };
    expect(await ran(policy)).toBe('MandateRuleError');
    expect(
      await ran({
        op: 'recover_token',
        token: { network: net.network, value: net.otherToken.address },
        amount: 1n,
      }),
    ).toBe('MandateRuleError');
    expect(await ran({ op: 'withdraw', amount: usdc(5n) })).toBe('ok');
    expect(await ran({ op: 'propose_principal', proposed: heir })).toBe('ok');
    expect(await ran({ op: 'accept_principal' }, heir)).toBe('ok');
    expect(await ran({ op: 'revoke' }, heir)).toBe('ok');
    const withdraw = await h.adapter
      .prepareMandateAction(
        {
          scope: h.scope,
          mandate: m.ref,
          action: { op: 'pause' },
          signer: { kind: 'external', network: net.network, role: 'principal', address: heir },
        },
        OPTS,
      )
      .then(
        () => 'ok',
        (error: unknown) => (error as Error).name,
      );
    expect(withdraw).toBe('MandateRuleError');
  });
});

describe('leases and signers', () => {
  function storeWith(store: AdapterStore, release: AdapterStore['releaseExecutor']): AdapterStore {
    return {
      recordSubmission: (s) => store.recordSubmission(s),
      updateSubmission: (...a) => store.updateSubmission(...a),
      findSubmission: (...a) => store.findSubmission(...a),
      liveSubmission: (k) => store.liveSubmission(k),
      unresolvedSubmissions: (...a) => store.unresolvedSubmissions(...a),
      leaseExecutor: (...a) => store.leaseExecutor(...a),
      releaseExecutor: release,
      upsertDelivery: (d) => store.upsertDelivery(d),
      liveDelivery: (...a) => store.liveDelivery(...a),
    };
  }

  it('skips the write-back when its lease was taken over, and rethrows anything else', async () => {
    const { h, m, net } = await world();
    const { signer, sponsorship, alerts } = h.world;
    const stale = storeWith(h.store, (lease: ExecutorLease) =>
      Promise.reject(new InvalidInputError({ issues: ['lease.leaseId (stale)'] })).finally(() =>
        h.store.releaseExecutor(lease, { sequenceOrNonce: lease.sequenceOrNonce + 1n }),
      ),
    );
    const adapter = new FakeChainAdapter(net, { store: stale, signer, sponsorship, alerts });
    const req = await payRequest(h, m, 'stale');
    expect((await drive(adapter, req)).at(-1)?.kind).toBe('final');
    expect(net.faults.trace).toContain('lease stale');
    const broken = storeWith(h.store, () =>
      Promise.reject(new InvalidInputError({ issues: ['lease (not_found)'] })),
    );
    const other = new FakeChainAdapter(net, { store: broken, signer, sponsorship, alerts });
    const next = await payRequest(h, m, 'broken');
    await other.pay(next, OPTS);
    expect((await refusalOf(other.pay(next, OPTS))).code).toBe('INVALID_INPUT');
  });

  it('refuses an executor key that controls another account', async () => {
    const { h, m, net } = await world();
    const signer = new FakeSigner(net.faults, () => net.now());
    for (const e of net.executors)
      signer.addExecutorKey(net.network, e.keyId, net.account('wrong').seed);
    const agent = net.account('managed-agent');
    signer.addManagedAgentKey(
      net.network,
      h.scope,
      '00000000-0000-4000-8000-0000000000a1',
      agent.seed,
    );
    const adapter = new FakeChainAdapter(net, {
      store: h.store,
      signer,
      sponsorship: h.world.sponsorship,
      alerts: h.world.alerts,
    });
    const req = await payRequest(h, m, 'mismatch');
    await adapter.pay(req, OPTS);
    expect((await refusalOf(adapter.pay(req, OPTS))).code).toBe('SIGNER_ADDRESS_MISMATCH');
    await expect(
      signer.sign(
        { kind: 'sep10', network: net.network, anchorId: 'a' },
        { kind: 'stellar_tx', network: net.network, xdr: 'AA==' },
      ),
    ).rejects.toMatchObject({ code: 'SIGNER_DENIED' });
    await expect(
      signer.sign(
        { kind: 'executor', network: net.network, keyId: 'executor-1' },
        { kind: 'attestation', network: net.network, fields: null as never },
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('signs an auth entry request and refuses a malformed envelope', async () => {
    const { h, m, net } = await world();
    const entry: SigningRequest = {
      kind: 'stellar_auth_entry',
      network: net.network,
      entryXdr: 'ZW50cnk=',
      signer: m.principal,
      expirationLedger: 9,
      summary: { action: 'pause', feePaidBy: 'ujira' },
      requestId: 'r',
    };
    expect(signFakeRequest(entry, net.account('wallet:principal').seed)).toMatch(
      /^fake-signed:v1:ZW50cnk=:G/,
    );
    const request = await h.adapter.prepareMandateAction(
      {
        scope: h.scope,
        mandate: m.ref,
        action: { op: 'pause' },
        signer: { kind: 'external', network: net.network, role: 'principal', address: m.principal },
      },
      OPTS,
    );
    const submit = (signed: string, scope: TenantScope = h.scope) =>
      h.adapter.submitSigned(
        { scope, requestId: request.requestId, signed, correlationId: 'c' },
        OPTS,
      );
    const xdr = request.kind === 'stellar_transaction' ? request.xdr : '';
    expect((await refusalOf(submit(`fake-signed:v1:${xdr}`))).code).toBe('SIGNED_PAYLOAD_MISMATCH');
    expect((await refusalOf(submit(`fake-signed:v1:${xdr}:${m.principal.value}:0x00`))).code).toBe(
      'SIGNED_PAYLOAD_MISMATCH',
    );
    const sameTenantOtherProject = {
      ...h.scope,
      projectId: '00000000-0000-4000-8000-00000000ffff' as Uuid,
    };
    expect((await refusalOf(submit('x', sameTenantOtherProject))).code).toBe('TENANT_MISMATCH');
    await expect(
      h
        .sign(request, h.wallet('x'))
        .then(() => h.sign(request, { ...m.principal, value: 'unknown' })),
    ).rejects.toThrow('not a harness wallet');
  });

  it('expires a held key request after its window', async () => {
    const { h, m } = await world();
    const req = await payRequest(h, m, 'held-expiry', { execute: 'hold' });
    await drive(h.adapter, req);
    const request = await h.adapter.prepareMandateAction(
      {
        scope: h.scope,
        mandate: m.ref,
        action: { op: 'cancel', payoutId: req.payoutId },
        signer: h.managedAgent.ref,
      },
      OPTS,
    );
    await h.advance(400n);
    const xdr = request.kind === 'stellar_transaction' ? request.xdr : '';
    const late = h.adapter.submitSigned(
      { scope: h.scope, requestId: request.requestId, signed: xdr, correlationId: 'c' },
      OPTS,
    );
    expect((await refusalOf(late)).code).toBe('SIGNING_REQUEST_EXPIRED');
  });
});

describe('stranded and replayed submissions', () => {
  it('expires a recorded payload that is sent again after its window', async () => {
    const { h, m, net } = await world();
    const signer = {
      kind: 'external' as const,
      network: net.network,
      role: 'principal' as const,
      address: m.principal,
    };
    const prepare = () =>
      h.adapter.prepareMandateAction(
        { scope: h.scope, mandate: m.ref, action: { op: 'pause' }, signer },
        OPTS,
      );
    const first = await prepare();
    const second = await prepare();
    const submission = async (r: SigningRequest) => ({
      scope: h.scope,
      requestId: r.requestId,
      signed: await h.sign(r, m.principal),
      correlationId: 'c',
    });
    net.faults.crash('after_record');
    await expect(h.adapter.submitSigned(await submission(first), OPTS)).rejects.toThrow(
      'simulated crash',
    );
    // One live pause at a time: the second cannot be recorded, and can be signed again later.
    expect((await refusalOf(h.adapter.submitSigned(await submission(second), OPTS))).code).toBe(
      'INVALID_INPUT',
    );
    await h.advance(400n);
    expect((await refusalOf(h.adapter.submitSigned(await submission(first), OPTS))).code).toBe(
      'SUBMISSION_REJECTED',
    );
    expect(h.moves().some((mv) => mv.to === 'expired')).toBe(true);
  });

  it('waits on an unknown submission that a reorganization dropped', async () => {
    const { h, m, net } = await world({ finalityDepth: 3 });
    const req = await payRequest(h, m, 'unknown-dropped');
    await h.adapter.pay(req, OPTS);
    net.faults.timeoutAfterLanding(1);
    expect((await refusalOf(h.adapter.pay(req, OPTS))).code).toBe('RPC_TIMEOUT');
    net.reorg(1);
    expect(net.finalHead).toBeGreaterThan(net.head - 3n);
    const waiting = await h.adapter.pay(req, OPTS);
    expect(waiting).toMatchObject({
      kind: 'submitted',
      op: 'execute',
      submission: { finality: 'none' },
    });
    const status = await h.adapter.status(
      { scope: h.scope, mandate: m.ref, payoutId: req.payoutId, legs: [] },
      OPTS,
    );
    expect(status.finality).toBe('included');
    expect(
      (await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS)).observedAt.finality,
    ).toBe('included');
    for (let i = 0; i < 6; i += 1) await h.advance(60n);
    expect((await drive(h.adapter, req)).at(-1)?.kind).toBe('settled');
  });
});

describe('pay and batch edges', () => {
  it('refuses a payout ID reused for another amount, a negative fee and an empty funding', async () => {
    const { h, m } = await world();
    const req = await payRequest(h, m, 'reuse', { execute: 'hold' });
    await drive(h.adapter, req);
    const leg = must(req.legs[0], 'one leg');
    const other: PayRequest = {
      ...req,
      total: usdc(2_000_000n),
      legs: [{ ...leg, amount: usdc(2_000_000n) }],
    };
    expect((await refusalOf(h.adapter.pay(other, OPTS))).code).toBe('INVALID_INPUT');
    expect((await refusalOf(h.adapter.pay({ ...req, fee: usdc(-1n) }, OPTS))).code).toBe(
      'INVALID_INPUT',
    );
    const empty = h.adapter.prepareFunding(
      { scope: h.scope, mandate: m.ref, from: m.principal, amount: usdc(0n) },
      OPTS,
    );
    expect((await refusalOf(empty)).code).toBe('INVALID_INPUT');
  });

  it('pays two legs, proves a rejection dead and reads another network as not found', async () => {
    const { h, m, net } = await world();
    const [a, b] = [must(m.recipients[0], 'a'), must(m.recipients[1], 'b')];
    await act(
      h,
      m.ref,
      {
        op: 'allow_recipients',
        entries: [{ recipientRef: a.recipientRef, destination: { address: b.address, tag: null } }],
      },
      m.principal,
    );
    const base = await payRequest(h, m, 'two-legs', { total: 3n });
    const leg = must(base.legs[0], 'one leg');
    const req: PayRequest = {
      ...base,
      legs: [
        {
          ...leg,
          index: 1,
          legKey: `${base.payoutId}01` as never,
          recipientMethodId: b.methodId,
          amount: usdc(1n),
        },
        { ...leg, amount: usdc(2n) },
      ],
    };
    const receipt = finalReceipt((await drive(h.adapter, req)).at(-1));
    expect(receipt.legs.map((l) => l.amount.amount)).toEqual([2n, 1n]);
    const otherNet = receipt.ref.replace(net.network, 'stellar:pubnet') as ReceiptRef;
    expect(await h.adapter.verifyReceipt(otherNet, OPTS)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    const big = await payRequest(h, m, 'rejected', { total: 200_000_000n });
    expect((await refusalOf(h.adapter.pay(big, OPTS))).code).toBe('MANDATE_RULE');
    const pending = await payRequest(h, m, 'to-reject');
    const deployed = await deployMandate(h, {
      approvers: 1,
      approvalThreshold: 1n,
      salt: 'second',
    });
    const p2 = {
      ...pending,
      mandate: deployed.ref,
      recipientRef: must(deployed.recipients[0], 'r').recipientRef,
      legs: [
        {
          ...must(pending.legs[0], 'leg'),
          recipientMethodId: must(deployed.recipients[0], 'r').methodId,
        },
      ],
    };
    expect((await h.adapter.pay(p2, OPTS)).kind).toBe('submitted');
    await act(h, deployed.ref, { op: 'reject', payoutId: p2.payoutId }, deployed.principal);
    const proof = await h.adapter.proveDead(
      { scope: h.scope, mandate: deployed.ref, payoutId: p2.payoutId, deadline: p2.deadline },
      OPTS,
    );
    expect(proof).toMatchObject({ kind: 'tombstone', status: 'rejected' });
  });

  it('reports refused, dead and failing batch items', async () => {
    const { h, m, net } = await world();
    const tooBig = await payRequest(h, m, 'too-big', { total: 200_000_000n });
    const refused = await h.adapter.payBatch(
      { scope: h.scope, mandate: m.ref, items: [tooBig] },
      OPTS,
    );
    expect(refused.items[0]?.step).toMatchObject({
      kind: 'item_failed',
      error: { specName: 'PAYMENT_CAP_EXCEEDED' },
    });
    const late = await payRequest(h, m, 'late', { deadline: net.now() });
    const dead = await h.adapter.payBatch({ scope: h.scope, mandate: m.ref, items: [late] }, OPTS);
    expect(dead.items[0]?.step.kind).toBe('dead');
    const held = await payRequest(h, m, 'held-batch', { execute: 'hold' });
    await drive(h.adapter, held);
    net.faults.signerDown();
    const down = h.adapter.payBatch(
      { scope: h.scope, mandate: m.ref, items: [{ ...held, execute: 'auto' }] },
      OPTS,
    );
    expect((await refusalOf(down)).code).toBe('SIGNER_UNAVAILABLE');
  });

  it('maps a failed balance read to an outage and scans other assets raw', async () => {
    const { h, m, net } = await world();
    net.token.setBalanceReadFailure(true);
    expect((await refusalOf(h.adapter.pay(await payRequest(h, m, 'read'), OPTS))).code).toBe(
      'CHAIN_UNAVAILABLE',
    );
    net.token.setBalanceReadFailure(false);
    net.include('ab'.repeat(32), 'fund', net.issuer, () => {
      net.otherToken.mint(m.ref.address.value, 9n);
    });
    net.include('cd'.repeat(32), 'fund', net.issuer, () => {
      net.otherToken.clawback(m.ref.address.value, 1n);
    });
    expect(() => net.include('cd'.repeat(32), 'fund', net.issuer, () => null)).toThrow(
      InvalidInputError,
    );
    const watched = (address: ChainAddress) =>
      Promise.resolve(
        address.value === m.ref.address.value
          ? { scope: h.scope, mandate: m.ref, asset: 'USDC' as const }
          : null,
      );
    const page = await h.adapter.scanDeposits(
      { cursor: null, limit: 10, isWatched: watched },
      OPTS,
    );
    expect(page.deposits.at(-1)).toMatchObject({
      asset: 'other',
      amount: { amount: 9n, scale: 7 },
    });
  });
});

describe('the fake network and harness', () => {
  it('refuses a bad depth, ignores a zero reorg and runs the anchor through the harness', () => {
    expect(() => new FakeNetwork({ finalityDepth: -1 })).toThrow(InvalidInputError);
    const net = new FakeNetwork({ finalityDepth: 1 });
    net.reorg(0);
    expect(net.head).toBe(1n);
    const h = fakeAdapterHarness();
    const faults = must(h.faults, 'faults');
    faults.anchorScript(null);
    expect(h.world.net.faults.anchor).toBe(null);
    expect(new FakeChainAdapter(net, { ...h.world, store: h.store }).network).toBe(
      'stellar:testnet',
    );
  });

  it('refusalOf rethrows anything that is not an adapter error and fails a call that passes', async () => {
    await expect(refusalOf(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(refusalOf(Promise.resolve(1))).rejects.toThrow('expected the call to be refused');
    expect(() => {
      must(undefined, 'something');
    }).toThrow('expected something');
    expect(() => finalReceipt({ kind: 'held' })).toThrow('expected a final step');
  });
});
