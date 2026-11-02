// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChainUnavailableError,
  RpcRateLimitedError,
  RpcTimeoutError,
  SubmissionUnknownError,
} from '../errors.js';
import { createStellarRpc } from './rpc.js';

const URL = 'https://rpc.example/key-0123456789abcdef';
const OPTS = { correlationId: 'c' };

function answering(body: unknown, status = 200) {
  const seen: { method: string; params: unknown; signal: AbortSignal | null }[] = [];
  const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(init?.body as string) as { method: string; params: unknown };
    seen.push({ ...sent, signal: init?.signal ?? null });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  });
  return { rpc: createStellarRpc({ network: 'stellar:testnet', url: URL, fetch }), seen };
}

function failing(error: Error) {
  return createStellarRpc({
    network: 'stellar:testnet',
    url: URL,
    fetch: () => Promise.reject(error),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createStellarRpc', () => {
  it('reads a page of contract events, from a ledger or a cursor', async () => {
    const event = {
      type: 'contract',
      contractId: 'CSOURCE',
      txHash: 'ab',
      id: '1-2',
      ledger: 12,
      ledgerClosedAt: '2026-11-02T00:00:00Z',
      inSuccessfulContractCall: true,
      topic: ['AAA='],
      value: 'BBB=',
    };
    const first = answering({ result: { events: [event], cursor: 'next', latestLedger: 20 } });
    expect(await first.rpc.getEvents({ startLedger: 5, limit: 10 }, OPTS)).toEqual({
      events: [event],
      cursor: 'next',
      latestLedger: 20,
    });
    expect(first.seen[0]?.params).toEqual({
      startLedger: 5,
      filters: [{ type: 'contract' }],
      pagination: { limit: 10 },
    });
    const later = answering({ result: { latestLedger: 21, cursor: '' } });
    expect(await later.rpc.getEvents({ cursor: 'next', limit: 10 }, OPTS)).toEqual({
      events: [],
      cursor: null,
      latestLedger: 21,
    });
    expect(later.seen[0]?.params).toEqual({
      filters: [{ type: 'contract' }],
      pagination: { limit: 10, cursor: 'next' },
    });
    // An event nothing says succeeded did not.
    const unsaid = { ...event } as Record<string, unknown>;
    delete unsaid['inSuccessfulContractCall'];
    const silent = answering({ result: { events: [unsaid], latestLedger: 22 } });
    const page = await silent.rpc.getEvents({ startLedger: 5, limit: 10 }, OPTS);
    expect(page.events[0]?.inSuccessfulContractCall).toBe(false);
  });

  it.each([
    ['events that are not a list', { events: 'x', latestLedger: 1 }],
    ['an event that is not an object', { events: ['x'], latestLedger: 1 }],
    ['an event with no topics', { events: [{ type: 'contract' }], latestLedger: 1 }],
    [
      'a topic that is not text',
      {
        events: [
          {
            type: 'contract',
            contractId: 'C',
            txHash: 'h',
            id: '1-1',
            ledger: 1,
            ledgerClosedAt: 't',
            topic: [1],
            value: 'v',
          },
        ],
        latestLedger: 1,
      },
    ],
    ['no latest ledger', { events: [] }],
  ])('treats %s as an outage of the endpoint', async (_name, result) => {
    const { rpc } = answering({ result });
    await expect(rpc.getEvents({ startLedger: 1, limit: 1 }, OPTS)).rejects.toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
    });
  });

  it('reads the latest ledger and ledger entries', async () => {
    const latest = answering({ result: { sequence: 12, closeTime: '1793483385' } });
    expect(await latest.rpc.getLatestLedger(OPTS)).toEqual({
      sequence: 12,
      closeTime: 1_793_483_385n,
    });
    expect(latest.seen[0]).toMatchObject({ method: 'getLatestLedger', params: {} });

    const entries = answering({
      result: {
        latestLedger: 50,
        entries: [
          { key: 'k1', xdr: 'x1', lastModifiedLedgerSeq: 3, liveUntilLedgerSeq: 99 },
          { key: 'k2', xdr: 'x2', lastModifiedLedgerSeq: 4 },
        ],
      },
    });
    expect(await entries.rpc.getLedgerEntries(['k1', 'k2'], OPTS)).toEqual({
      latestLedger: 50,
      entries: [
        { key: 'k1', xdr: 'x1', lastModifiedLedgerSeq: 3, liveUntilLedgerSeq: 99 },
        { key: 'k2', xdr: 'x2', lastModifiedLedgerSeq: 4 },
      ],
    });
    expect(entries.seen[0]?.params).toEqual({ keys: ['k1', 'k2'] });
    const none = answering({ result: { latestLedger: 50 } });
    expect((await none.rpc.getLedgerEntries(['k'], OPTS)).entries).toEqual([]);
  });

  it('simulates, sends and looks up transactions', async () => {
    const sim = answering({ result: { latestLedger: 7, error: 'boom' } });
    expect(await sim.rpc.simulateTransaction('tx', OPTS)).toEqual({
      latestLedger: 7,
      error: 'boom',
    });
    expect(sim.seen[0]?.params).toEqual({ transaction: 'tx' });

    const sent = answering({ result: { status: 'ERROR', hash: 'h', errorResultXdr: 'e' } });
    expect(await sent.rpc.sendTransaction('tx', OPTS)).toEqual({
      status: 'ERROR',
      hash: 'h',
      errorResultXdr: 'e',
    });
    const pending = answering({ result: { status: 'PENDING', hash: 'h' } });
    expect(await pending.rpc.sendTransaction('tx', OPTS)).toEqual({ status: 'PENDING', hash: 'h' });

    const found = answering({ result: { status: 'SUCCESS', ledger: 9, resultXdr: 'r' } });
    expect(await found.rpc.getTransaction('h', OPTS)).toEqual({
      status: 'SUCCESS',
      ledger: 9,
      resultXdr: 'r',
    });
    const window = answering({
      result: {
        status: 'NOT_FOUND',
        latestLedger: 90,
        latestLedgerCloseTime: '1793483385',
        oldestLedger: 10,
      },
    });
    expect(await window.rpc.getTransaction('h', OPTS)).toEqual({
      status: 'NOT_FOUND',
      latestLedger: 90,
      latestLedgerCloseTime: 1_793_483_385n,
      oldestLedger: 10,
    });
    const missing = answering({ result: { status: 'NOT_FOUND' } });
    expect(await missing.rpc.getTransaction('h', OPTS)).toEqual({ status: 'NOT_FOUND' });
  });

  it('treats a result in the wrong shape as an unusable endpoint', async () => {
    const bad: [unknown, (rpc: ReturnType<typeof createStellarRpc>) => Promise<unknown>][] = [
      [{ result: { sequence: 'x', closeTime: '1' } }, (r) => r.getLatestLedger(OPTS)],
      [{ result: { sequence: 1 } }, (r) => r.getLatestLedger(OPTS)],
      [{ result: { latestLedger: 1, entries: {} } }, (r) => r.getLedgerEntries([], OPTS)],
      [{ result: { latestLedger: 1, entries: [3] } }, (r) => r.getLedgerEntries([], OPTS)],
      [{ result: {} }, (r) => r.simulateTransaction('tx', OPTS)],
      [{ result: { status: 'MAYBE' } }, (r) => r.getTransaction('h', OPTS)],
      [{ error: { code: -32602, message: 'invalid params' } }, (r) => r.getLatestLedger(OPTS)],
      [[], (r) => r.getLatestLedger(OPTS)],
      ['not json', (r) => r.getLatestLedger(OPTS)],
    ];
    for (const [body, call] of bad) {
      await expect(call(answering(body).rpc)).rejects.toBeInstanceOf(ChainUnavailableError);
    }
  });

  it('never says a send did not land once the endpoint has taken it', async () => {
    const taken: unknown[] = [
      { result: { status: 'LOST', hash: 'h' } },
      { result: { status: 'PENDING' } },
      { error: { code: -32603, message: 'internal' } },
      [],
      'not json',
    ];
    for (const body of taken) {
      const send = answering(body).rpc.sendTransaction('tx', OPTS);
      await expect(send).rejects.toBeInstanceOf(SubmissionUnknownError);
      await expect(send).rejects.toMatchObject({ landed: 'unknown' });
    }
    const failed = answering({}, 502).rpc.sendTransaction('tx', OPTS);
    await expect(failed).rejects.toBeInstanceOf(SubmissionUnknownError);
    // A refusal from the rate limiter is the one answer that says it was not taken.
    await expect(answering({}, 429).rpc.sendTransaction('tx', OPTS)).rejects.toBeInstanceOf(
      RpcRateLimitedError,
    );
  });

  it('maps HTTP failures, rate limits and timeouts, and never quotes the URL', async () => {
    await expect(answering({}, 429).rpc.getLatestLedger(OPTS)).rejects.toBeInstanceOf(
      RpcRateLimitedError,
    );
    await expect(answering({}, 503).rpc.getLatestLedger(OPTS)).rejects.toBeInstanceOf(
      ChainUnavailableError,
    );

    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const readTimeout = failing(timeout).getLatestLedger(OPTS);
    await expect(readTimeout).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(readTimeout).rejects.toMatchObject({ landed: 'no' });
    const sendTimeout = failing(timeout).sendTransaction('tx', OPTS);
    await expect(sendTimeout).rejects.toMatchObject({ code: 'RPC_TIMEOUT', landed: 'unknown' });
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(failing(aborted).getLatestLedger(OPTS)).rejects.toBeInstanceOf(RpcTimeoutError);

    const dropped = new TypeError(`fetch failed for ${URL}`);
    const read = failing(dropped).getLatestLedger(OPTS);
    await expect(read).rejects.toBeInstanceOf(ChainUnavailableError);
    const send = failing(dropped).sendTransaction('tx', OPTS);
    await expect(send).rejects.toBeInstanceOf(SubmissionUnknownError);
    const error = await send.catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain('rpc.example');
    expect(String((error as Error).cause)).not.toContain('rpc.example');
  });

  it('passes the caller signal through and defaults to the global fetch', async () => {
    const controller = new AbortController();
    const { rpc, seen } = answering({ result: { sequence: 1, closeTime: '2' } });
    await rpc.getLatestLedger({ correlationId: 'c', signal: controller.signal });
    controller.abort();
    expect(seen[0]?.signal?.aborted).toBe(true);

    const global = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ result: { sequence: 3, closeTime: '4' } }))),
    );
    vi.stubGlobal('fetch', global);
    const plain = createStellarRpc({ network: 'stellar:testnet', url: URL });
    expect((await plain.getLatestLedger(OPTS)).sequence).toBe(3);
    expect(global).toHaveBeenCalledOnce();
  });
});
