// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fake adapter passes the same conformance suite the Stellar adapter
// must. The cases below it cover what only the fake can stage on demand:
// reorganizations, crashes between write-ahead and broadcast, an anchor's
// scripted delivery, and the fake's own input checks.

import { money, tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import type {
  CallOptions,
  ChainAddress,
  CountryCode,
  PayRequest,
  QuoteRequest,
  UnixSeconds,
} from '../types.js';

import type { SubmissionMove } from './index.js';
import {
  FakeAlerts,
  FakeChainAdapter,
  FakeSigner,
  FakeSponsorship,
  MandateFactory,
  SUBMISSION_TRANSITIONS,
  SimulatedCrash,
  act,
  deployMandate,
  describeChainAdapter,
  drive,
  fakeAdapterHarness,
  payRequest,
  refusalOf,
} from './index.js';
import type { Bytes32 } from '../types.js';
import { mandateAddressOf } from '../stellar/mandate-address.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import { addressXdr } from './address.js';
import { mandateTenantTag } from './fake-network.js';

describeChainAdapter('FakeChainAdapter', () => fakeAdapterHarness(), { faults: true });

const OPTS: CallOptions = { correlationId: 'fake-test' };
const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', 'stellar');

function forwardOnly(moves: readonly SubmissionMove[]): boolean {
  return moves.every((m) =>
    m.from === null ? m.to === 'built' : SUBMISSION_TRANSITIONS[m.from].includes(m.to),
  );
}

function executions(h: ReturnType<typeof fakeAdapterHarness>, payoutId: string): number {
  return h.world.net.txs
    .flatMap((tx) => tx.events)
    .filter((e) => e.name === 'payout_executed' && e.fields['payout_id'] === payoutId).length;
}

async function world(options: Parameters<typeof fakeAdapterHarness>[0] = {}) {
  const h = fakeAdapterHarness(options);
  const m = await deployMandate(h);
  return { h, m, net: h.world.net };
}

describe('reorganizations', () => {
  it('drops an execution, reports it, and executes again without paying twice', async () => {
    const { h, m, net } = await world({ finalityDepth: 3 });
    const req = await payRequest(h, m, 'reorg');
    const recipient = m.recipients[0]?.address ?? m.principal;
    const before = await h.balance(recipient);
    const steps = await drive(h.adapter, req);
    const settled = steps.at(-1);
    if (settled?.kind !== 'settled') throw new Error('expected a settled step');
    expect(settled.receipt.finality).toBe('included');
    net.reorg(1);
    expect(await h.balance(recipient)).toBe(before);
    expect(await h.adapter.verifyReceipt(settled.receipt.ref, OPTS)).toEqual({
      ok: false,
      reason: 'reorged',
    });
    const receipt = h.adapter.receipt(
      { scope: h.scope, mandate: m.ref, payoutId: req.payoutId },
      OPTS,
    );
    expect((await refusalOf(receipt)).code).toBe('REORGED');
    expect(h.world.alerts.alerts.map((a) => a.kind)).toEqual(['divergence', 'divergence']);
    expect((await drive(h.adapter, req)).at(-1)?.kind).toBe('settled');
    for (let i = 0; i < 3; i += 1) await h.advance(5n);
    expect((await drive(h.adapter, req)).at(-1)?.kind).toBe('final');
    expect(executions(h, req.payoutId)).toBe(1);
    expect((await h.balance(recipient)) - before).toBe(1_000_000n);
    expect(forwardOnly(h.moves())).toBe(true);
  });

  it('reports a dropped deposit on the next scan and refuses a reorg past finality', async () => {
    const { h, m, net } = await world({ finalityDepth: 2 });
    const watched = (address: ChainAddress) =>
      Promise.resolve(
        address.value === m.ref.address.value
          ? { scope: h.scope, mandate: m.ref, asset: 'USDC' as const }
          : null,
      );
    const first = await h.adapter.scanDeposits(
      { cursor: null, limit: 10, isWatched: watched },
      OPTS,
    );
    await h.fund(m.ref.address, 7n);
    const page = await h.adapter.scanDeposits(
      { cursor: first.nextCursor, limit: 10, isWatched: watched },
      OPTS,
    );
    expect(page.deposits.map((d) => [d.amount.amount, d.finality])).toEqual([[7n, 'included']]);
    net.reorg(1);
    const after = await h.adapter.scanDeposits(
      { cursor: page.nextCursor, limit: 10, isWatched: watched },
      OPTS,
    );
    expect(after.reorged).toEqual([{ txHash: page.deposits[0]?.txHash, eventIndex: 0 }]);
    const again = await h.adapter.scanDeposits(
      { cursor: after.nextCursor, limit: 10, isWatched: watched },
      OPTS,
    );
    expect(again.reorged).toEqual([]);
    expect(() => {
      net.reorg(3);
    }).toThrow();
    const bad = h.adapter.scanDeposits({ cursor: 'nope', limit: 10, isWatched: watched }, OPTS);
    expect((await refusalOf(bad)).code).toBe('INVALID_INPUT');
  });

  it('does not prove a cancellation dead before it is final', async () => {
    const { h, m } = await world({ finalityDepth: 2 });
    const req = await payRequest(h, m, 'unfinal', { execute: 'hold' });
    await drive(h.adapter, req);
    await act(h, m.ref, { op: 'cancel', payoutId: req.payoutId }, m.principal);
    const step = await h.adapter.pay(req, OPTS);
    expect(step).toMatchObject({ kind: 'submitted', submission: { finality: 'included' } });
    await h.advance(5n);
    await h.advance(5n);
    expect((await h.adapter.pay(req, OPTS)).kind).toBe('dead');
  });
});

describe('crashes', () => {
  it('sends the same envelope again after a crash before broadcast', async () => {
    const { h, m, net } = await world();
    const req = await payRequest(h, m, 'crash-record');
    net.faults.crash('after_record');
    await expect(h.adapter.pay(req, OPTS)).rejects.toBeInstanceOf(SimulatedCrash);
    const live = h.world.store.submissions.filter((s) => s.state === 'built');
    expect(live.length).toBe(1);
    expect((await drive(h.restart(), req)).at(-1)?.kind).toBe('final');
    expect(net.tx(live[0]?.txHash ?? '')).toBeDefined();
    expect(forwardOnly(h.moves())).toBe(true);
  });

  it('reconciles after a crash between broadcast and the result', async () => {
    const { h, m, net } = await world();
    const req = await payRequest(h, m, 'crash-broadcast');
    await h.adapter.pay(req, OPTS);
    net.faults.crash('after_broadcast');
    await expect(h.adapter.pay(req, OPTS)).rejects.toBeInstanceOf(SimulatedCrash);
    // The crashed process kept its executor lease; the pool has another.
    expect((await drive(h.restart(), req)).at(-1)?.kind).toBe('final');
    expect(executions(h, req.payoutId)).toBe(1);
    expect(forwardOnly(h.moves())).toBe(true);
  });

  it('expires a stranded record once its window passes and submits anew', async () => {
    const { h, m, net } = await world();
    const req = await payRequest(h, m, 'stranded', {
      deadline: (net.now() + 3_600n) as UnixSeconds,
    });
    net.faults.crash('after_record');
    await expect(h.adapter.pay(req, OPTS)).rejects.toBeInstanceOf(SimulatedCrash);
    net.faults.chainDown();
    const down = await refusalOf(h.restart().pay(req, OPTS));
    expect(down.code).toBe('CHAIN_UNAVAILABLE');
    net.faults.chainDown(false);
    await h.advance(120n);
    expect((await drive(h.restart(), req)).at(-1)?.kind).toBe('final');
    expect(h.moves().some((mv) => mv.to === 'expired')).toBe(true);
    expect(forwardOnly(h.moves())).toBe(true);
  });

  it('sends a signed payload recorded before a crash when it is submitted again', async () => {
    const { h, m, net } = await world();
    const signer = {
      kind: 'external' as const,
      network: net.network,
      role: 'principal' as const,
      address: m.principal,
    };
    const request = await h.adapter.prepareMandateAction(
      { scope: h.scope, mandate: m.ref, action: { op: 'pause' }, signer },
      OPTS,
    );
    const signed = await h.sign(request, m.principal);
    const submission = { scope: h.scope, requestId: request.requestId, signed, correlationId: 'c' };
    net.faults.chainDown();
    expect((await refusalOf(h.adapter.submitSigned(submission, OPTS))).code).toBe(
      'CHAIN_UNAVAILABLE',
    );
    net.faults.chainDown(false);
    net.faults.crash('after_record');
    await expect(h.adapter.submitSigned(submission, OPTS)).rejects.toBeInstanceOf(SimulatedCrash);
    // Another process knows the hash but not the envelope, so it reports it unseen.
    expect((await h.restart().submitSigned(submission, OPTS)).finality).toBe('none');
    expect((await h.adapter.submitSigned(submission, OPTS)).finality).toBe('final');
    const failing = await h.adapter.prepareMandateAction(
      { scope: h.scope, mandate: m.ref, action: { op: 'resume' }, signer },
      OPTS,
    );
    const resume = {
      ...submission,
      requestId: failing.requestId,
      signed: await h.sign(failing, m.principal),
    };
    await act(h, m.ref, { op: 'resume' }, m.principal);
    expect((await refusalOf(h.adapter.submitSigned(resume, OPTS))).code).toBe('MANDATE_RULE');
    expect((await refusalOf(h.adapter.submitSigned(resume, OPTS))).code).toBe('MANDATE_RULE');
  });
});

describe('the SEP-31 rail', () => {
  const anchor = {
    anchorId: 'anchor-ng',
    currency: 'NGN' as const,
    country: 'NG' as CountryCode,
    rate: { numerator: 150_000n, denominator: 10_000_000n },
    fee: 100_000n,
    steps: [
      { afterSeconds: 0, state: 'in_transit' as const, rawStatus: 'pending_receiver' },
      { afterSeconds: 60, state: 'delivered' as const, rawStatus: 'completed' },
    ],
  };

  function quoteRequest(
    h: ReturnType<typeof fakeAdapterHarness>,
    o: Partial<QuoteRequest> = {},
  ): QuoteRequest {
    return {
      scope: h.scope,
      rail: 'stellar.sep31',
      country: 'NG' as CountryCode,
      sell: { asset: 'USDC' },
      buy: { currency: 'NGN' },
      amount: { side: 'sell', value: usdc(10_100_000n) },
      firm: true,
      ...o,
    };
  }

  it('quotes both sides and refuses what the anchor cannot do', async () => {
    const { h, net } = await world();
    const unavailable = await refusalOf(h.adapter.quote(quoteRequest(h), OPTS));
    expect(unavailable.code).toBe('RAIL_UNAVAILABLE');
    net.faults.anchorScript(anchor);
    expect(h.adapter.capabilities().rails[1]).toMatchObject({
      enabled: true,
      deliveryCurrencies: ['NGN'],
    });
    const sell = await h.adapter.quote(quoteRequest(h), OPTS);
    expect(sell).toMatchObject({
      source: 'sep38',
      buy: money(150_000n, 'NGN'),
      providerRef: 'anchor-ng',
    });
    const buy = await h.adapter.quote(
      quoteRequest(h, { amount: { side: 'buy', value: money(150_000n, 'NGN') } }),
      OPTS,
    );
    expect(buy.sell.amount).toBe(10_100_000n);
    const refusals = [
      quoteRequest(h, { buy: { currency: 'KES' } }),
      quoteRequest(h, { amount: { side: 'sell', value: usdc(100_000n) } }),
      quoteRequest(h, { rail: 'stellar.wallet' }),
      quoteRequest(h, {
        rail: 'stellar.wallet',
        buy: { currency: 'USDC' },
        amount: { side: 'buy', value: money(1n, 'USD') },
      }),
    ];
    for (const r of refusals)
      expect((await refusalOf(h.adapter.quote(r, OPTS))).code).toBe('QUOTE_UNAVAILABLE');
    const badBuy = quoteRequest(h, { amount: { side: 'buy', value: money(1n, 'KES') } });
    expect((await refusalOf(h.adapter.quote(badBuy, OPTS))).code).toBe('INVALID_INPUT');
  });

  it('records the anchor delivery and follows its script', async () => {
    const { h, m, net } = await world();
    net.faults.anchorScript(anchor);
    const anchorAccount = h.wallet('anchor-account');
    const recipient = m.recipients[0];
    if (recipient === undefined) throw new Error('a recipient');
    const entry = {
      recipientRef: recipient.recipientRef,
      destination: { address: anchorAccount, tag: 42n },
    };
    await act(h, m.ref, { op: 'allow_recipients', entries: [entry] }, m.principal);
    const methodId = h.recipientMethod({ address: anchorAccount, tag: 42n });
    const base = await payRequest(h, m, 'anchor');
    const leg = base.legs[0];
    if (leg === undefined) throw new Error('one leg');
    const req: PayRequest = {
      ...base,
      legs: [
        { ...leg, rail: 'stellar.sep31', recipientMethodId: methodId, deliveryCurrency: 'NGN' },
      ],
    };
    expect((await drive(h.adapter, req)).at(-1)?.kind).toBe('final');
    const status = () =>
      h.adapter.status(
        { scope: h.scope, mandate: m.ref, payoutId: req.payoutId, legs: [leg.legKey] },
        OPTS,
      );
    expect((await status()).legs).toMatchObject([
      {
        rail: 'stellar.sep31',
        state: 'in_transit',
        provider: { id: 'anchor-ng', rawStatus: 'pending_receiver' },
      },
    ]);
    await h.advance(61n);
    expect((await status()).legs).toMatchObject([
      { state: 'delivered', provider: { rawStatus: 'completed' } },
    ]);
    net.faults.anchorScript(null);
    const next = await payRequest(h, m, 'anchor-off');
    const nextLeg = next.legs[0];
    if (nextLeg === undefined) throw new Error('one leg');
    const off: PayRequest = {
      ...next,
      legs: [{ ...nextLeg, rail: 'stellar.sep31', recipientMethodId: methodId }],
    };
    expect((await refusalOf(h.adapter.pay(off, OPTS))).code).toBe('RAIL_UNAVAILABLE');
    const health = await h.adapter.health(OPTS);
    expect(health.rails[1]).toMatchObject({ state: 'down', reason: 'NOT_CONFIGURED' });
  });
});

describe('input and trust checks', () => {
  it('refuses a tag copied from another mandate of the same tenant, as the real adapter does', async () => {
    const { h, m, net } = await world();
    const snap = await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS);
    const copy = net.factory.create(
      { caller: m.principal.value },
      {
        principal: m.principal.value,
        asset: net.token.address,
        recipientMode: 'ALLOWLIST',
        tenantTag: snap.config.tenantTag,
        agents: [h.managedAgent.address.value],
        approvers: [],
        approvalsRequired: 0,
        guardians: [],
        executors: [],
        recovery: [],
        recoveryThreshold: 0,
        limits: {
          totalBudget: 10n,
          perPaymentCap: 10n,
          perRecipientDailyCap: 10n,
          approvalThreshold: 11n,
          payoutTtlSeconds: 3_600n,
          expiresAt: snap.config.limits.expiresAt,
        },
        attester: null,
        countryPolicyHash: snap.config.countryPolicyHash,
        maxFeeBps: 0,
      },
      `0x${'6b'.repeat(32)}`,
    );
    const mandate = { ...m.ref, address: { network: net.network, value: copy.address } };
    await expect(h.adapter.readMandate({ scope: h.scope, mandate }, OPTS)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
  });

  it('stores the tag bound to the mandate, never the reference, as the real adapter does', async () => {
    const { h, m, net } = await world();
    const snap = await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS);
    const expected = tenantTagOf(tenantRefOf(h.scope), addressXdr(m.ref.address.value));
    expect(snap.config.tenantTag).toBe(expected);
    expect(snap.config.tenantTag).not.toBe(tenantRefOf(h.scope));
    expect(snap.tenantTagMatches).toBe(true);
    expect('tenantRef' in snap.config).toBe(false);

    // The fake factory and the real adapter put a mandate at the same address.
    const principal = m.principal.value;
    const salt = `0x${'5a'.repeat(32)}` as Bytes32;
    expect(net.factory.mandateAddress(principal, salt)).toBe(
      mandateAddressOf(net.network, net.factory.address, principal, salt),
    );
  });

  it('refuses a mandate from an untrusted factory, a wrong network and an unknown address', async () => {
    const { h, m, net } = await world();
    const rogue = new MandateFactory(net.ledger, {
      address: net.contract('rogue-factory'),
      feeAddress: net.feeAddress,
      assets: [net.token.address],
    });
    const snap = await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS);
    const engine = rogue.create(
      { caller: m.principal.value },
      {
        principal: m.principal.value,
        asset: net.token.address,
        recipientMode: 'ALLOWLIST',
        tenantTag: mandateTenantTag(
          h.scope,
          rogue.mandateAddress(m.principal.value, snap.config.countryPolicyHash),
        ),
        agents: [h.managedAgent.address.value],
        approvers: [],
        approvalsRequired: 0,
        guardians: [],
        executors: [],
        recovery: [],
        recoveryThreshold: 0,
        limits: {
          totalBudget: 10n,
          perPaymentCap: 10n,
          perRecipientDailyCap: 10n,
          approvalThreshold: 11n,
          payoutTtlSeconds: 3_600n,
          expiresAt: snap.config.limits.expiresAt,
        },
        attester: null,
        countryPolicyHash: snap.config.countryPolicyHash,
        maxFeeBps: 0,
      },
      snap.config.countryPolicyHash,
    );
    const rogueRef = { ...m.ref, address: { network: net.network, value: engine.address } };
    const read = await h.adapter.readMandate({ scope: h.scope, mandate: rogueRef }, OPTS);
    expect(read.trustedFactory).toBe(false);
    const untrusted = h.adapter.fundingInstructions({ scope: h.scope, mandate: rogueRef }, OPTS);
    expect((await refusalOf(untrusted)).code).toBe('MANDATE_UNTRUSTED');
    const wrongNet = { ...m.ref, network: 'stellar:pubnet' as const };
    const missing = { ...m.ref, address: { network: net.network, value: net.contract('nothing') } };
    for (const mandate of [wrongNet, missing]) {
      const call = h.adapter.readMandate({ scope: h.scope, mandate }, OPTS);
      expect((await refusalOf(call)).code).toBe('INVALID_INPUT');
    }
  });

  it('refuses aborted calls, malformed actions and signers on another network', async () => {
    const { h, m } = await world();
    const controller = new AbortController();
    controller.abort();
    const aborted = await refusalOf(
      h.adapter.readMandate(
        { scope: h.scope, mandate: m.ref },
        { ...OPTS, signal: controller.signal },
      ),
    );
    expect(aborted).toMatchObject({ code: 'RPC_TIMEOUT', landed: 'no' });
    const signer = {
      kind: 'external' as const,
      network: h.adapter.network,
      role: 'principal' as const,
      address: m.principal,
    };
    const createWithMandate = h.adapter.prepareMandateAction(
      {
        scope: h.scope,
        mandate: m.ref,
        action: {
          op: 'create',
          factory: h.factory,
          config: null as never,
          salt: m.ref.address.value as never,
        },
        signer,
      },
      OPTS,
    );
    expect((await refusalOf(createWithMandate)).code).toBe('INVALID_INPUT');
    const pauseWithout = h.adapter.prepareMandateAction(
      { scope: h.scope, mandate: null, action: { op: 'pause' }, signer },
      OPTS,
    );
    expect((await refusalOf(pauseWithout)).code).toBe('INVALID_INPUT');
    const otherNet = h.adapter.prepareMandateAction(
      {
        scope: h.scope,
        mandate: m.ref,
        action: { op: 'pause' },
        signer: { ...signer, network: 'stellar:pubnet' },
      },
      OPTS,
    );
    expect((await refusalOf(otherNet)).code).toBe('INVALID_INPUT');
    const otherAddress = h.adapter.prepareMandateAction(
      {
        scope: h.scope,
        mandate: m.ref,
        action: { op: 'pause' },
        signer: { ...signer, address: { ...m.principal, network: 'stellar:pubnet' } },
      },
      OPTS,
    );
    expect((await refusalOf(otherAddress)).code).toBe('INVALID_INPUT');
    const req = await payRequest(h, m, 'checks');
    const [leg0] = req.legs;
    if (leg0 === undefined) throw new Error('one leg');
    const bad: PayRequest[] = [
      { ...req, total: tokenAmount(0n, 'USDC', 'stellar'), legs: [] },
      { ...req, total: { ...req.total, scale: 2 } },
      { ...req, legs: [{ ...leg0, index: 7 }] },
      {
        ...req,
        legs: [{ ...leg0, recipientMethodId: 'unknown' as never }],
      },
    ];
    for (const r of bad)
      expect((await refusalOf(h.adapter.pay(r, OPTS))).code).toBe('INVALID_INPUT');
  });

  it('signs a held key action as prepared and refuses anything else', async () => {
    const { h, m } = await world();
    const req = await payRequest(h, m, 'held-cancel', { execute: 'hold' });
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
    expect(request).toMatchObject({ sponsored: false });
    const submit = (signed: string) =>
      h.adapter.submitSigned(
        { scope: h.scope, requestId: request.requestId, signed, correlationId: 'c' },
        OPTS,
      );
    expect((await refusalOf(submit('other'))).code).toBe('SIGNED_PAYLOAD_MISMATCH');
    const xdr = request.kind === 'stellar_transaction' ? request.xdr : '';
    expect((await submit(xdr)).finality).toBe('final');
    expect((await h.adapter.pay(req, OPTS)).kind).toBe('dead');
    const unknownAgent = {
      ...h.managedAgent.ref,
      agentId: '00000000-0000-4000-8000-0000000000ff' as never,
    };
    const denied = await refusalOf(
      h.adapter.pay(await payRequest(h, m, 'denied', { signer: unknownAgent }), OPTS),
    );
    expect(denied.code).toBe('SIGNER_DENIED');
  });

  it('checks batches and fails every item of a refused execution', async () => {
    const { h, m, net } = await world();
    const items = await Promise.all(['x1', 'x2'].map((label) => payRequest(h, m, label)));
    const batch = (list: readonly PayRequest[]) =>
      h.adapter.payBatch({ scope: h.scope, mandate: m.ref, items: list }, OPTS);
    const [first] = items;
    if (first === undefined) throw new Error('two items');
    const wallet = h.wallet('batch-agent');
    const external = {
      kind: 'external' as const,
      network: net.network,
      role: 'agent' as const,
      address: wallet,
    };
    const invalid = [
      [],
      [first, first],
      [
        first,
        {
          ...first,
          payoutId: items[1]?.payoutId as never,
          legs: items[1]?.legs ?? [],
          signer: external,
        },
      ],
      [
        {
          ...first,
          mandate: {
            ...m.ref,
            address: { network: net.network, value: net.contract('elsewhere') },
          },
        },
      ],
    ];
    for (const list of invalid) expect((await refusalOf(batch(list))).code).toBe('INVALID_INPUT');
    const recipient = m.recipients[0]?.address ?? m.principal;
    net.faults.transferFails(recipient.value);
    const failed = await batch(items);
    expect(failed.items.map((i) => i.step.kind)).toEqual(['item_failed', 'item_failed']);
    expect(failed.items[0]?.step).toMatchObject({ error: { code: 'MANDATE_RULE', specCode: 72 } });
    net.faults.transferFails(recipient.value, false);
    const capped = await payRequest(h, m, 'x3', { fee: 1_000_000n });
    const mixed = await batch([...items, capped]);
    expect(mixed.items.map((i) => i.step.kind)).toEqual(['submitted', 'submitted', 'item_failed']);
    await act(h, m.ref, { op: 'add_role', role: 'agent', account: wallet }, m.principal);
    const signed = await batch([
      await payRequest(h, m, 'x4', { signer: external }),
      await payRequest(h, m, 'x5', { signer: external }),
    ]);
    expect(signed.items.map((i) => i.step.kind)).toEqual([
      'signature_required',
      'signature_required',
    ]);
    const dup = await payRequest(h, m, 'x1');
    expect((await batch([dup])).items[0]?.step.kind).toBe('final');
  });
});

describe('the fake ports', () => {
  it('records alerts, sponsorship states and refuses payloads it cannot sign', async () => {
    const { h, net } = await world();
    const alerts = new FakeAlerts();
    const balance = { network: net.network, asset: 'XLM' as const, amount: 1n, scale: 7 as const };
    alerts.lowBalance({ network: net.network, account: 'executor', balance, threshold: balance });
    alerts.stuck({ network: net.network, txHash: 'aa', ageSeconds: 9, correlationId: 'c' });
    expect(alerts.alerts.map((a) => a.kind)).toEqual(['lowBalance', 'stuck']);
    const sponsorship = new FakeSponsorship(net.faults);
    const r = {
      scope: h.scope,
      network: net.network,
      reservationId: 'r1',
      intent: 'pause' as const,
      maxFee: balance,
    };
    await sponsorship.reserve(r);
    await sponsorship.reserve(r);
    await sponsorship.release({ scope: h.otherScope, reservationId: 'r1' });
    expect(sponsorship.reservations[0]?.state).toBe('reserved');
    await sponsorship.release({ scope: h.scope, reservationId: 'r1' });
    await sponsorship.settle({ scope: h.scope, reservationId: 'r1', actualFee: balance });
    expect(sponsorship.reservations[0]?.state).toBe('released');
    const signer = new FakeSigner(net.faults, () => net.now());
    signer.addFeeSponsorKey(net.network, net.feeSponsor.seed);
    const ref = { kind: 'fee_sponsor' as const, network: net.network };
    expect((await signer.address(ref)).value).toBe(net.feeSponsor.address);
    const payloads = [
      { kind: 'stellar_fee_bump' as const, network: net.network, xdr: 'AA==' },
      { kind: 'sep10_challenge' as const, network: net.network, xdr: 'AA==' },
      {
        kind: 'stellar_auth_entry' as const,
        network: net.network,
        entryXdr: 'AA==',
        expirationLedger: 9,
      },
    ];
    for (const p of payloads) expect((await signer.sign(ref, p)).signature.length).toBe(64);
    expect(signer.signatures).toBe(3);
    await expect(
      signer.sign(ref, { kind: 'stellar_tx', network: 'stellar:pubnet', xdr: 'AA==' }),
    ).rejects.toMatchObject({ code: 'SIGNER_DENIED' });
    await expect(
      signer.sign({ kind: 'attester', network: net.network }, payloads[0] as never),
    ).rejects.toMatchObject({ code: 'SIGNER_DENIED' });
    await expect(
      signer.address({ kind: 'executor', network: net.network, keyId: 'none' }),
    ).rejects.toMatchObject({ code: 'SIGNER_DENIED' });
    expect(new FakeChainAdapter(net, { store: h.store, signer, sponsorship, alerts }).network).toBe(
      net.network,
    );
  });

  it('runs on pubnet with its own passphrase and reports a success rate', async () => {
    const { h, m } = await world({ network: 'stellar:pubnet' });
    expect(h.adapter.network).toBe('stellar:pubnet');
    expect((await h.adapter.health(OPTS)).submitSuccessRate5m).toBe(10_000);
    expect((await drive(h.adapter, await payRequest(h, m, 'pubnet'))).at(-1)?.kind).toBe('final');
  });
});
