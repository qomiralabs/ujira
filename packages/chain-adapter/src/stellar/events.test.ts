// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Keypair, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { encodeMuxedAddress } from '../codecs/strkey.js';
import { decodeAccountAddress } from '../codecs/strkey.js';
import { ChainUnavailableError } from '../errors.js';
import { PUBLIC_TEST_ATTESTER_KEYS } from '../test-attester-keys.js';
import { MemoryEventIntakeStore } from '../testing/event-intake-store.js';
import {
  createStellarEventIntake,
  createStellarEventSource,
  ledgerEventOf,
  scanLedgerEvents,
  stellarTenantTag,
} from './events.js';
import type { RpcEvent } from './rpc.js';
import { address, bytes, bytes32, destination, i128, struct, sym, u32, u64, vec } from './scval.js';
import { FIXTURE_FACTORY } from './test-rpc.js';
import { NETWORK, OPTS, setup } from './test-adapter.js';
import type { Bytes32 } from '../types.js';

const PAYOUT = `0x${'cd'.repeat(32)}` as Bytes32;
const CONTRACT = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

function raw(over: Partial<RpcEvent> = {}): RpcEvent {
  return {
    type: 'contract',
    contractId: CONTRACT,
    txHash: 'ab'.repeat(32),
    id: '0000000123456-0000000007',
    ledger: 123,
    ledgerClosedAt: '2026-11-02T00:00:00Z',
    inSuccessfulContractCall: true,
    topic: [sym('payout_requested').toXdr('base64'), bytes32('k', PAYOUT).toXdr('base64')],
    value: struct({ total: i128('total', 5n) }).toXdr('base64'),
    ...over,
  };
}

describe('a public test attester key as the ledger encodes it', () => {
  const TAG = `0x${'ef'.repeat(32)}` as Bytes32;
  const topic = (name: string) => [sym(name).toXdr('base64'), bytes32('k', TAG).toXdr('base64')];

  async function registeredIntake() {
    const store = new MemoryEventIntakeStore();
    const intake = createStellarEventIntake({
      network: NETWORK,
      store,
      trustedFactories: () => [FIXTURE_FACTORY],
    });
    await intake.ingest(
      ledgerEventOf(
        NETWORK,
        raw({
          contractId: FIXTURE_FACTORY,
          topic: topic('mandate_created'),
          value: struct({ mandate: address('mandate', CONTRACT) }).toXdr('base64'),
        }),
      ),
    );
    return { store, intake };
  }

  it.each(PUBLIC_TEST_ATTESTER_KEYS)('flags %s on mandate_initialized', async (key) => {
    const { store, intake } = await registeredIntake();
    const initialized = raw({
      topic: topic('mandate_initialized'),
      value: struct({ attester: bytes('attester', Buffer.from(key, 'hex')) }).toXdr('base64'),
    });
    expect(await intake.ingest(ledgerEventOf(NETWORK, initialized))).toEqual({
      action: 'flagged',
      contractId: CONTRACT,
    });
    expect(store.alerts).toEqual([{ contractId: CONTRACT, reason: 'public_test_attester' }]);
  });

  it('leaves a mandate with no attester alone', async () => {
    const { store, intake } = await registeredIntake();
    const initialized = raw({
      topic: topic('mandate_initialized'),
      value: struct({ attester: xdr.ScVal.scvVoid() }).toXdr('base64'),
    });
    await intake.ingest(ledgerEventOf(NETWORK, initialized));
    expect(store.alerts).toEqual([]);
  });
});

describe('reading an event off the ledger', () => {
  it('takes the source and the position from the ledger', () => {
    expect(ledgerEventOf(NETWORK, raw())).toEqual({
      network: NETWORK,
      contractId: CONTRACT,
      type: 'contract',
      successful: true,
      txHash: 'ab'.repeat(32),
      eventIndex: 7n,
      ledger: 123n,
      closedAt: '2026-11-02T00:00:00Z',
      name: 'payout_requested',
      key: PAYOUT,
      fields: { total: '5' },
    });
  });

  it('keeps every integer exact as text and every byte string as hex', () => {
    const big = (1n << 126n) + 1n;
    const fields = ledgerEventOf(
      NETWORK,
      raw({
        value: struct({
          code: u32('code', 7),
          when: u64('when', 18_446_744_073_709_551_615n),
          total: i128('total', big),
          hash: bytes('hash', Uint8Array.of(1, 255)),
          on: xdr.ScVal.scvBool(true),
          off: xdr.ScVal.scvVoid(),
          who: address('who', CONTRACT),
          list: vec([u32('a', 1)]),
          inner: struct({ n: u32('n', 2) }),
        }).toXdr('base64'),
      }),
    ).fields;
    expect(fields).toEqual({
      code: '7',
      when: '18446744073709551615',
      total: big.toString(),
      hash: '0x01ff',
      on: true,
      off: null,
      who: CONTRACT,
      list: ['1'],
      inner: { n: '2' },
    });
  });

  it('reads a tagged destination in a payout leg', () => {
    const account = Keypair.random().publicKey();
    const muxed = encodeMuxedAddress(decodeAccountAddress(account), 9n);
    const fields = ledgerEventOf(
      NETWORK,
      raw({
        value: struct({
          legs: vec([
            struct({
              destination: destination('d', {
                address: { network: NETWORK, value: account },
                tag: 9n,
              }),
            }),
          ]),
        }).toXdr('base64'),
      }),
    ).fields;
    expect(fields).toEqual({ legs: [{ destination: muxed }] });
  });

  it.each<[string, Partial<RpcEvent>]>([
    ['one topic', { topic: [sym('x').toXdr('base64')] }],
    [
      'three topics',
      {
        topic: [
          sym('x').toXdr('base64'),
          bytes32('k', PAYOUT).toXdr('base64'),
          sym('y').toXdr('base64'),
        ],
      },
    ],
    [
      'a name that is not a symbol',
      { topic: [u32('n', 1).toXdr('base64'), bytes32('k', PAYOUT).toXdr('base64')] },
    ],
    ['a key that is not bytes', { topic: [sym('x').toXdr('base64'), sym('y').toXdr('base64')] }],
    [
      'a short key',
      { topic: [sym('x').toXdr('base64'), bytes('k', Uint8Array.of(1)).toXdr('base64')] },
    ],
    ['a topic that is not XDR', { topic: ['***', '***'] }],
    ['data that is not XDR', { value: '***' }],
    ['data that is not a map', { value: vec([u32('a', 1)]).toXdr('base64') }],
    ['data that is empty', { value: xdr.ScVal.scvVoid().toXdr('base64') }],
  ])('treats %s as no known shape, without stopping', (_name, over) => {
    expect(ledgerEventOf(NETWORK, raw(over))).toMatchObject({
      name: null,
      key: null,
      fields: null,
    });
  });

  it('treats a value that has no place in an event as no known shape', () => {
    const value = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: sym('e'),
        val: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: 1n })),
      }),
    ]).toXdr('base64');
    expect(ledgerEventOf(NETWORK, raw({ value })).fields).toBeNull();
  });

  it('treats an id it cannot read as an endpoint fault', () => {
    expect(() => ledgerEventOf(NETWORK, raw({ id: 'nonsense' }))).toThrow(ChainUnavailableError);
  });

  it('reads a page', async () => {
    const page = await scanLedgerEvents(
      NETWORK,
      {
        getEvents: () => Promise.resolve({ events: [raw()], cursor: 'next', latestLedger: 200 }),
      },
      { startLedger: 1, limit: 10 },
      OPTS,
    );
    expect(page.cursor).toBe('next');
    expect(page.latestLedger).toBe(200);
    expect(page.events[0]?.eventIndex).toBe(7n);
  });
});

describe('from the factory event to an accepted mandate', { timeout: 30_000 }, () => {
  it('registers from the ledger and only then is the mandate readable', async () => {
    const t = setup({ registered: false });
    const store = new MemoryEventIntakeStore();
    const intake = createStellarEventIntake({
      network: NETWORK,
      store,
      trustedFactories: () => [FIXTURE_FACTORY],
    });
    const mandate = t.mandate.address.value;
    const tag = stellarTenantTag(t.scope, mandate);
    t.registry.answer = (network, contract) => store.registered(network, contract);
    const read = () => t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS);
    await expect(read()).rejects.toMatchObject({ code: 'MANDATE_UNTRUSTED' });

    // The same event from a copycat first: it changes nothing.
    const event = {
      topic: [sym('mandate_created').toXdr('base64'), bytes32('k', tag).toXdr('base64')],
      value: struct({ mandate: address('m', mandate) }).toXdr('base64'),
    };
    await intake.ingest(ledgerEventOf(NETWORK, raw({ ...event, contractId: mandate })));
    await expect(read()).rejects.toMatchObject({ code: 'MANDATE_UNTRUSTED' });

    await intake.ingest(ledgerEventOf(NETWORK, raw({ ...event, contractId: FIXTURE_FACTORY })));
    expect((await read()).trustedFactory).toBe(true);
  });
});

describe('the event source the scan reads', () => {
  function source(answer: { cursor: string | null }) {
    const asked: unknown[] = [];
    const rpc = {
      getEvents: (request: unknown) => {
        asked.push(request);
        return Promise.resolve({ events: [raw()], cursor: answer.cursor, latestLedger: 300 });
      },
    };
    return { asked, events: createStellarEventSource({ network: NETWORK, rpc, startLedger: 42 }) };
  }

  it('starts at the configured ledger, then carries the node cursor', async () => {
    const s = source({ cursor: 'abc' });
    const first = await s.events.page(null, 10, OPTS);
    expect(s.asked[0]).toEqual({ startLedger: 42, limit: 10 });
    expect(first).toMatchObject({ nextCursor: 'stellar:v1:cursor:abc', latestLedger: 300 });
    expect(first.events[0]?.contractId).toBe(CONTRACT);
    await s.events.page(first.nextCursor, 10, OPTS);
    expect(s.asked[1]).toEqual({ cursor: 'abc', limit: 10 });
  });

  it('stays where it was when the node gives no cursor, so nothing is skipped', async () => {
    const s = source({ cursor: null });
    expect((await s.events.page(null, 10, OPTS)).nextCursor).toBe('stellar:v1:ledger:42');
    expect((await s.events.page('stellar:v1:ledger:77', 10, OPTS)).nextCursor).toBe(
      'stellar:v1:ledger:77',
    );
    expect((await s.events.page('stellar:v1:cursor:x', 10, OPTS)).nextCursor).toBe(
      'stellar:v1:cursor:x',
    );
  });

  it.each(['nonsense', 'stellar:v1:', 'stellar:v1:cursor:', 'stellar:v1:ledger:x'])(
    'refuses the cursor %s',
    async (cursor) => {
      await expect(source({ cursor: null }).events.page(cursor, 10, OPTS)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    },
  );
});
