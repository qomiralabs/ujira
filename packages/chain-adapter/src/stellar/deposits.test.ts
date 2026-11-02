// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Keypair } from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { sweepDepositOf } from '../deposit-event.js';
import type {
  Deposit,
  DepositScanRequest,
  ForwardingRoute,
  TenantScope,
  Uuid,
  WatchedMandate,
} from '../types.js';
import type { RpcEvent } from './rpc.js';
import { address, i128, struct, sym, u64 } from './scval.js';
import { NETWORK, OPTS } from './test-adapter.js';
import { payWorld, refusal } from './test-payouts.js';
import type { PayWorld } from './test-payouts.js';
import { invoked } from './test-rpc.js';

const OTHER_TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SENDER = Keypair.random().publicKey();

const usdcOf = (w: PayWorld) => w.ports.config()[NETWORK]?.assets.USDC.sac ?? '';
const mandateOf = (w: PayWorld) => w.mandate.address.value;

function transfer(
  w: PayWorld,
  over: Partial<RpcEvent> & { to?: string; amount?: bigint } = {},
): RpcEvent {
  const { to, amount, ...rest } = over;
  return {
    type: 'contract',
    contractId: usdcOf(w),
    txHash: 'ab'.repeat(32),
    id: '0000000123456-0000000002',
    ledger: 123,
    ledgerClosedAt: '2026-11-02T00:00:00Z',
    inSuccessfulContractCall: true,
    topic: [
      sym('transfer').toXdr('base64'),
      address('from', SENDER).toXdr('base64'),
      address('to', to ?? mandateOf(w)).toXdr('base64'),
    ],
    value: i128('amount', amount ?? 500n).toXdr('base64'),
    ...rest,
  };
}

function pageOf(w: PayWorld, events: readonly RpcEvent[], cursor: string | null = 'next') {
  const requests: unknown[] = [];
  w.rpc.getEvents = (request) => {
    requests.push(request);
    return Promise.resolve({ events, cursor, latestLedger: 200 });
  };
  return requests;
}

const watchedAs = (w: PayWorld, over: Partial<WatchedMandate> = {}): WatchedMandate => ({
  scope: w.scope,
  mandate: w.mandate,
  asset: 'USDC',
  ...over,
});

function scan(
  w: PayWorld,
  isWatched: DepositScanRequest['isWatched'] = (a) =>
    Promise.resolve(a.value === mandateOf(w) ? watchedAs(w) : null),
  cursor: string | null = null,
) {
  return w.payouts.scanDeposits({ cursor, limit: 100, isWatched }, OPTS);
}

const keys = (deposits: readonly Deposit[]) =>
  deposits.map((d) => `${d.txHash}:${String(d.eventIndex)}`);

describe('detecting deposits', { timeout: 30_000 }, () => {
  it('reads a USDC transfer into a watched mandate', async () => {
    const w = payWorld();
    pageOf(w, [transfer(w)]);
    const page = await scan(w);
    expect(page.deposits).toEqual([
      {
        scope: w.scope,
        mandate: w.mandate,
        txHash: 'ab'.repeat(32),
        eventIndex: 2,
        from: { network: NETWORK, value: SENDER },
        asset: 'USDC',
        tokenContract: usdcOf(w),
        amount: tokenAmount(500n, 'USDC', 'stellar'),
        ledgerOrBlock: 123n,
        blockHash: null,
        closedAt: 1_793_577_600n,
        finality: 'final',
        operationId: '123456',
      },
    ]);
    expect(page.head).toEqual({ ledgerOrBlock: 200n, safe: 200n, final: 200n });
    expect(page.reorged).toEqual([]);
  });

  it('a page replay does not duplicate deposits', async () => {
    const w = payWorld();
    const event = transfer(w);
    pageOf(w, [event, event]);
    const first = await scan(w);
    expect(first.deposits).toHaveLength(1);
    // The same range read again names the same deposits, which is what the
    // unique key on the transaction and event index holds the line on.
    expect(keys((await scan(w)).deposits)).toEqual(keys(first.deposits));
  });

  it('an XLM transfer is reported as other', async () => {
    const w = payWorld();
    pageOf(w, [transfer(w, { contractId: OTHER_TOKEN })]);
    const [deposit] = (await scan(w)).deposits;
    expect(deposit).toMatchObject({
      asset: 'other',
      tokenContract: OTHER_TOKEN,
      amount: { amount: 500n, scale: 7 },
    });
  });

  it('reads the amount from the map a tagged transfer writes', async () => {
    const w = payWorld();
    pageOf(w, [
      transfer(w, {
        value: struct({ amount: i128('a', 77n), to_muxed_id: u64('m', 9n) }).toXdr('base64'),
      }),
    ]);
    expect((await scan(w)).deposits[0]).toMatchObject({ amount: { amount: 77n } });
  });

  it('keeps a source that is not an address as unknown', async () => {
    const w = payWorld();
    const [name, , to] = transfer(w).topic;
    pageOf(w, [transfer(w, { topic: [name ?? '', sym('mint').toXdr('base64'), to ?? ''] })]);
    expect((await scan(w)).deposits[0]?.from).toBeNull();
  });

  it.each<[string, (w: PayWorld) => RpcEvent]>([
    ['a failed call', (w) => transfer(w, { inSuccessfulContractCall: false })],
    ['a diagnostic event', (w) => transfer(w, { type: 'diagnostic' })],
    ['a zero amount', (w) => transfer(w, { amount: 0n })],
    ['a negative amount', (w) => transfer(w, { amount: -1n })],
    ['data that holds no amount', (w) => transfer(w, { value: sym('x').toXdr('base64') })],
    [
      'a map with a bad amount',
      (w) => transfer(w, { value: struct({ amount: sym('x') }).toXdr('base64') }),
    ],
    ['data that is not XDR', (w) => transfer(w, { value: '***' })],
    [
      'another event name',
      (w) => {
        const [, from, to] = transfer(w).topic;
        return transfer(w, { topic: [sym('mint').toXdr('base64'), from ?? '', to ?? ''] });
      },
    ],
    [
      'a name that is not a symbol',
      (w) => {
        const [, from, to] = transfer(w).topic;
        return transfer(w, { topic: [address('x', SENDER).toXdr('base64'), from ?? '', to ?? ''] });
      },
    ],
    ['too few topics', (w) => transfer(w, { topic: [sym('transfer').toXdr('base64')] })],
    [
      'a recipient that is not an address',
      (w) => {
        const [name, from] = transfer(w).topic;
        return transfer(w, { topic: [name ?? '', from ?? '', sym('x').toXdr('base64')] });
      },
    ],
  ])('skips %s, and the rest of the page still counts', async (_name, build) => {
    const w = payWorld();
    pageOf(w, [build(w), transfer(w, { id: '0000000123456-0000000009' })]);
    const { deposits } = await scan(w);
    expect(deposits.map((d) => d.eventIndex)).toEqual([9]);
  });

  it('looks each address up once a page', async () => {
    const w = payWorld();
    pageOf(w, [
      transfer(w, { id: '0000000123456-0000000001' }),
      transfer(w, { id: '0000000123456-0000000002' }),
    ]);
    let lookups = 0;
    const { deposits } = await scan(w, () => {
      lookups += 1;
      return Promise.resolve(watchedAs(w));
    });
    expect(deposits).toHaveLength(2);
    expect(lookups).toBe(1);
  });

  it('ignores an address nobody watches, without an alert', async () => {
    const w = payWorld();
    pageOf(w, [transfer(w)]);
    expect((await scan(w, () => Promise.resolve(null))).deposits).toEqual([]);
    expect(w.divergences).toEqual([]);
  });
});

describe('the cursor', { timeout: 30_000 }, () => {
  it('starts at the configured ledger, then carries on from the node cursor', async () => {
    const w = payWorld();
    const requests = pageOf(w, []);
    const first = await scan(w);
    expect(requests[0]).toMatchObject({
      startLedger: w.ports.config()[NETWORK]?.deposits.startLedger,
      limit: 100,
    });
    expect(first.nextCursor).toBe('stellar:v1:cursor:next');
    await scan(w, undefined, first.nextCursor);
    expect(requests[1]).toMatchObject({ cursor: 'next' });
  });

  it('stays where it was when the node gives no cursor, so nothing is skipped', async () => {
    const w = payWorld();
    pageOf(w, [], null);
    const first = await scan(w);
    expect(first.nextCursor).toMatch(/^stellar:v1:ledger:\d+$/);
    const requests = pageOf(w, [], null);
    const again = await scan(w, undefined, first.nextCursor);
    expect(again.nextCursor).toBe(first.nextCursor);
    expect(requests[0]).toHaveProperty('startLedger');
    const carried = pageOf(w, [], null);
    expect((await scan(w, undefined, 'stellar:v1:cursor:abc')).nextCursor).toBe(
      'stellar:v1:cursor:abc',
    );
    expect(carried[0]).toMatchObject({ cursor: 'abc' });
  });

  it.each(['nonsense', 'stellar:v1:', 'stellar:v1:cursor:', 'stellar:v1:ledger:x'])(
    'refuses %s',
    async (cursor) => {
      const w = payWorld();
      pageOf(w, []);
      await expect(scan(w, undefined, cursor)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    },
  );

  it.each([0, 1001, 1.5])('refuses a limit of %s', async (limit) => {
    const w = payWorld();
    await expect(
      w.payouts.scanDeposits({ cursor: null, limit, isWatched: () => Promise.resolve(null) }, OPTS),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('treats an event id it cannot read as an endpoint fault', async () => {
    const w = payWorld();
    pageOf(w, [transfer(w, { id: 'nonsense' })]);
    await expect(scan(w)).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
  });

  it('treats a close time it cannot read as an endpoint fault', async () => {
    const w = payWorld();
    pageOf(w, [transfer(w, { ledgerClosedAt: 'nonsense' })]);
    await expect(scan(w)).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
  });
});

describe('whose deposit it is', { timeout: 30_000 }, () => {
  const OTHER: TenantScope = {
    principalId: '00000000-0000-4000-8000-000000000098' as Uuid,
    projectId: '00000000-0000-4000-8000-000000000099' as Uuid,
  };

  function refused(w: PayWorld) {
    expect(w.divergences).toEqual([
      expect.objectContaining({ kind: 'balance', detail: 'deposit_not_attributed' }),
    ]);
  }

  it('asks only about the address the ledger says received it', async () => {
    const w = payWorld();
    const asked: string[] = [];
    // The data names another contract, which must not change who is asked about.
    pageOf(w, [
      transfer(w, {
        value: struct({ amount: i128('a', 5n), to: address('t', OTHER_TOKEN) }).toXdr('base64'),
      }),
    ]);
    await scan(w, (a) => {
      asked.push(a.value);
      return Promise.resolve(watchedAs(w));
    });
    expect(asked).toEqual([mandateOf(w)]);
  });

  it('credits a look-alike to no one, whatever the lookup says', async () => {
    const w = payWorld({ registered: false });
    pageOf(w, [transfer(w)]);
    expect((await scan(w)).deposits).toEqual([]);
    refused(w);
  });

  it('refuses a lookup naming a tenant the mandate is not tagged for', async () => {
    const w = payWorld();
    pageOf(w, [transfer(w)]);
    const { deposits } = await scan(w, () => Promise.resolve(watchedAs(w, { scope: OTHER })));
    expect(deposits).toEqual([]);
    refused(w);
  });

  it('refuses a lookup that answers with another mandate', async () => {
    const w = payWorld();
    pageOf(w, [transfer(w, { to: OTHER_TOKEN })]);
    expect((await scan(w, () => Promise.resolve(watchedAs(w)))).deposits).toEqual([]);
    refused(w);
  });

  it('refuses a lookup on another network', async () => {
    const w = payWorld();
    pageOf(w, [transfer(w)]);
    const mandate = { ...w.mandate, network: 'stellar:pubnet' as const };
    expect((await scan(w, () => Promise.resolve(watchedAs(w, { mandate })))).deposits).toEqual([]);
    refused(w);
  });

  it('credits a flagged mandate to no one', async () => {
    const w = payWorld({ registration: { flagged: true } });
    pageOf(w, [transfer(w)]);
    expect((await scan(w)).deposits).toEqual([]);
    refused(w);
  });

  it('credits a mandate whose factory left the trusted list to no one', async () => {
    const w = payWorld({ registration: { factory: OTHER_TOKEN } });
    pageOf(w, [transfer(w)]);
    expect((await scan(w)).deposits).toEqual([]);
    refused(w);
  });

  describe('on a forwarding account', () => {
    const forwarder = Keypair.random().publicKey();
    const route = (w: PayWorld, over: Partial<ForwardingRoute> = {}): ForwardingRoute => ({
      fundingSourceId: '00000000-0000-4000-8000-0000000000f1',
      mandateInstanceId: '00000000-0000-4000-8000-0000000000f2',
      forwarder,
      mandate: mandateOf(w),
      ...over,
    });

    it('attributes USDC to the tenant of the mandate it forwards to, ready to sweep', async () => {
      const w = payWorld();
      pageOf(w, [transfer(w, { to: forwarder })]);
      const { deposits } = await scan(w, (a) =>
        Promise.resolve(a.value === forwarder ? watchedAs(w, { forwarding: route(w) }) : null),
      );
      const [deposit] = deposits;
      if (deposit === undefined) throw new Error('no deposit');
      expect(deposit).toMatchObject({ scope: w.scope, forwarding: route(w) });
      expect(sweepDepositOf(NETWORK, deposit)).toEqual({
        scope: w.scope,
        network: NETWORK,
        depositOperationId: '123456',
        fundingSourceId: '00000000-0000-4000-8000-0000000000f1',
        mandateInstanceId: '00000000-0000-4000-8000-0000000000f2',
        route: { forwarder, mandate: mandateOf(w), token: usdcOf(w) },
        amount: tokenAmount(500n, 'USDC', 'stellar'),
      });
    });

    it('reports another asset, and never sweeps it', async () => {
      const w = payWorld();
      pageOf(w, [transfer(w, { to: forwarder, contractId: OTHER_TOKEN })]);
      const { deposits } = await scan(w, () =>
        Promise.resolve(watchedAs(w, { forwarding: route(w) })),
      );
      const [deposit] = deposits;
      if (deposit === undefined) throw new Error('no deposit');
      expect(deposit.asset).toBe('other');
      expect(deposit).not.toHaveProperty('forwarding');
      expect(sweepDepositOf(NETWORK, deposit)).toBeNull();
    });

    it('has nothing to sweep for a deposit straight into a mandate', async () => {
      const w = payWorld();
      pageOf(w, [transfer(w)]);
      const [deposit] = (await scan(w)).deposits;
      if (deposit === undefined) throw new Error('no deposit');
      expect(sweepDepositOf(NETWORK, deposit)).toBeNull();
      expect(sweepDepositOf('stellar:pubnet', { ...deposit, forwarding: route(w) })).toBeNull();
      const noOperation = Object.fromEntries(
        Object.entries(deposit).filter(([key]) => key !== 'operationId'),
      ) as unknown as Deposit;
      expect(sweepDepositOf(NETWORK, { ...noOperation, forwarding: route(w) })).toBeNull();
    });

    it.each<[string, (w: PayWorld) => Partial<ForwardingRoute>]>([
      ['another account', () => ({ forwarder: Keypair.random().publicKey() })],
      ['another mandate', () => ({ mandate: OTHER_TOKEN })],
    ])('refuses a route naming %s', async (_name, over) => {
      const w = payWorld();
      pageOf(w, [transfer(w, { to: forwarder })]);
      const { deposits } = await scan(w, () =>
        Promise.resolve(watchedAs(w, { forwarding: route(w, over(w)) })),
      );
      expect(deposits).toEqual([]);
      refused(w);
    });

    it('refuses a forwarder routing to a look-alike', async () => {
      const w = payWorld({ registered: false });
      pageOf(w, [transfer(w, { to: forwarder })]);
      const { deposits } = await scan(w, () =>
        Promise.resolve(watchedAs(w, { forwarding: route(w) })),
      );
      expect(deposits).toEqual([]);
      refused(w);
    });
  });
});

describe('funding', { timeout: 30_000 }, () => {
  it('names the mandate, the asset contract and the issuer, as a contract address', async () => {
    const w = payWorld();
    const config = w.ports.config()[NETWORK];
    expect(
      await w.payouts.fundingInstructions({ scope: w.scope, mandate: w.mandate }, OPTS),
    ).toEqual({
      mandate: w.mandate,
      address: { network: NETWORK, value: mandateOf(w) },
      asset: 'USDC',
      assetContract: config?.assets.USDC.sac,
      assetIssuer: config?.assets.USDC.issuer,
      label: 'Stellar contract address, fund from your wallet',
      memoRequired: false,
      warnings: [
        'other_assets_not_credited',
        'wrong_network_lost',
        'exchange_contract_address_support',
      ],
      availableAt: config?.deposits.availableAt,
    });
  });

  const fund = (w: PayWorld, over = {}) =>
    w.payouts.prepareFunding(
      {
        scope: w.scope,
        mandate: w.mandate,
        from: { network: NETWORK, value: w.principal.publicKey() },
        amount: tokenAmount(500n, 'USDC', 'stellar'),
        ...over,
      },
      OPTS,
    );

  it('builds a transfer into the mandate from the principal, with the fee sponsored', async () => {
    const w = payWorld();
    const request = await fund(w);
    expect(request).toMatchObject({
      kind: 'stellar_transaction',
      sponsored: true,
      summary: { action: 'fund', feePaidBy: 'ujira', amount: { amount: 500n } },
    });
    const tx = w.rpc.simulated.at(-1);
    if (tx === undefined) throw new Error('nothing simulated');
    const call = invoked(tx);
    expect(call.contract).toBe(usdcOf(w));
    expect(call.fn).toBe('transfer');
    const to = call.args[1];
    expect(to?.toXdr('base64')).toBe(address('to', mandateOf(w)).toXdr('base64'));
  });

  it('is refused for a look-alike, for instructions and for a transfer', async () => {
    const w = payWorld({ registered: false });
    await expect(
      w.payouts.fundingInstructions({ scope: w.scope, mandate: w.mandate }, OPTS),
    ).rejects.toMatchObject({ code: 'MANDATE_UNTRUSTED' });
    await expect(fund(w)).rejects.toMatchObject({ code: 'MANDATE_UNTRUSTED' });
  });

  it('refuses nothing to send and another network', async () => {
    const w = payWorld();
    await expect(fund(w, { amount: tokenAmount(0n, 'USDC', 'stellar') })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      fund(w, { from: { network: 'stellar:pubnet', value: w.principal.publicKey() } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('reads a refusal from the token as a failed transfer, never as a mandate rule', async () => {
    const w = payWorld();
    // The token numbers its errors from 10, which would read as UNAUTHORIZED.
    w.refused.set('transfer', () => refusal(usdcOf(w), 'UNAUTHORIZED'));
    await expect(fund(w)).rejects.toMatchObject({ specName: 'TRANSFER_FAILED' });
  });
});
