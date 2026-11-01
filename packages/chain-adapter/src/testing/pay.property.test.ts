// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One logical payout driven through the fake adapter on two networks while
// pay calls, crashes, timeouts, outages, reorganizations and the clock are
// interleaved at random. The job here fails over to the other network only
// with a proof that the current attempt is dead, as the payout job does.
// Whatever the order, no payout ID executes twice, no attempt executes
// after it was proved dead, and so at most one attempt ever pays.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ChainAdapterError } from '../errors.js';
import type { CallOptions, ChainAdapter, PayRequest, UnixSeconds } from '../types.js';

import {
  SUBMISSION_TRANSITIONS,
  SimulatedCrash,
  deployMandate,
  fakeAdapterHarness,
  payRequest,
} from './index.js';
import type { CrashPoint, SuiteMandate } from './index.js';

const PROPERTY_TIMEOUT_MS = 600_000;
const OPTS: CallOptions = { correlationId: 'property' };
const AMOUNT = 1_000_000n;

type Action =
  | { readonly kind: 'pay' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'crash'; readonly point: CrashPoint }
  | { readonly kind: 'down' }
  | { readonly kind: 'reorg'; readonly side: 0 | 1; readonly depth: 1 | 2 }
  | { readonly kind: 'advance'; readonly seconds: 5 | 60 | 700 }
  | { readonly kind: 'failover' };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ kind: 'pay' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'timeout' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('crash' as const),
      point: fc.constantFrom<CrashPoint>('after_record', 'after_broadcast'),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'down' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('reorg' as const),
      side: fc.constantFrom<0 | 1>(0, 1),
      depth: fc.constantFrom<1 | 2>(1, 2),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      seconds: fc.constantFrom<5 | 60 | 700>(5, 60, 700),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'failover' as const }) },
);

interface Side {
  readonly h: ReturnType<typeof fakeAdapterHarness>;
  readonly m: SuiteMandate;
  adapter: ChainAdapter;
}

interface Attempt {
  readonly side: Side;
  readonly req: PayRequest;
  provedDead: boolean;
}

async function side(network: 'stellar:testnet' | 'stellar:pubnet'): Promise<Side> {
  const h = fakeAdapterHarness({ network, finalityDepth: 2 });
  const m = await deployMandate(h);
  return { h, m, adapter: h.adapter };
}

function executed(s: Side, payoutId: string): number {
  return s.h.world.net.txs
    .flatMap((tx) => tx.events)
    .filter((e) => e.name === 'payout_executed' && e.fields['payout_id'] === payoutId).length;
}

async function call<T>(s: Side, body: (adapter: ChainAdapter) => Promise<T>): Promise<T | null> {
  try {
    return await body(s.adapter);
  } catch (error) {
    // The process died; the next one starts from the chain and the store.
    if (error instanceof SimulatedCrash) {
      s.adapter = s.h.restart();
      return null;
    }
    if (error instanceof ChainAdapterError) return null;
    throw error;
  }
}

async function run(actions: readonly Action[]): Promise<void> {
  const sides = [await side('stellar:testnet'), await side('stellar:pubnet')] as const;
  const attempts: Attempt[] = [];
  const start = async (): Promise<Attempt> => {
    const n = attempts.length + 1;
    const s = n % 2 === 0 ? sides[0] : sides[1];
    const deadline = (s.h.world.net.now() + 600n) as UnixSeconds;
    const req = await payRequest(s.h, s.m, `logical-payout:${String(n)}`, {
      attempt: n,
      deadline,
      total: AMOUNT,
    });
    const attempt = { side: s, req, provedDead: false };
    attempts.push(attempt);
    return attempt;
  };
  let current = await start();

  const failover = async (): Promise<void> => {
    const { side: s, req } = current;
    const proof = await call(s, (a) =>
      a.proveDead(
        { scope: s.h.scope, mandate: s.m.ref, payoutId: req.payoutId, deadline: req.deadline },
        OPTS,
      ),
    );
    if (proof === null) return;
    current.provedDead = true;
    current = await start();
  };

  const pay = async (): Promise<string | null> => {
    const { side: s, req } = current;
    const step = await call(s, (a) => a.pay(req, OPTS));
    if (step?.kind === 'dead') {
      current.provedDead = true;
      current = await start();
    }
    return step?.kind ?? null;
  };

  for (const action of actions) {
    const faults = current.side.h.world.net.faults;
    switch (action.kind) {
      case 'pay':
        await pay();
        break;
      case 'timeout':
        faults.timeoutAfterLanding(1);
        break;
      case 'crash':
        faults.crash(action.point);
        break;
      case 'down':
        faults.chainDown(!faults.isChainDown());
        break;
      case 'reorg': {
        const net = sides[action.side].h.world.net;
        net.reorg(Math.min(action.depth, net.reorgableDepth));
        break;
      }
      case 'advance':
        for (const s of sides) await s.h.advance(BigInt(action.seconds));
        break;
      case 'failover':
        await failover();
        break;
    }
  }

  // Calm: every fault stops and the job runs the payout to rest.
  for (const s of sides) s.h.world.net.faults.clear();
  for (let i = 0; i < 40; i += 1) {
    if ((await pay()) === 'final') break;
    for (const s of sides) await s.h.advance(5n);
  }

  const counts = attempts.map((a) => executed(a.side, a.req.payoutId));
  expect(counts.every((c) => c <= 1)).toBe(true);
  expect(counts.reduce((sum, c) => sum + c, 0)).toBeLessThanOrEqual(1);
  for (const [i, a] of attempts.entries()) {
    if (a.provedDead) expect(counts[i]).toBe(0);
  }
  // Exactly the executed amount reached the recipient, across both networks.
  let received = 0n;
  for (const s of sides) {
    const recipient = s.m.recipients[0]?.address;
    if (recipient !== undefined) received += await s.h.balance(recipient);
  }
  expect(received).toBe(AMOUNT * BigInt(counts.reduce((sum, c) => sum + c, 0)));
  for (const s of sides) {
    const store = s.h.world.store;
    const live = store.submissions.filter((r) =>
      ['built', 'broadcast', 'unknown'].includes(r.state),
    );
    const keys = live.map((r) => `${r.network}|${r.mandate ?? ''}|${r.payoutId ?? ''}|${r.op}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const move of store.moves) {
      if (move.from !== null) expect(SUBMISSION_TRANSITIONS[move.from]).toContain(move.to);
    }
  }
}

describe('pay under random faults', { timeout: PROPERTY_TIMEOUT_MS }, () => {
  it('never executes twice and never pays a second attempt', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 16 }), (actions) =>
        run(actions),
      ),
      { seed: 0x69fa, numRuns: 1_000 },
    );
  });
});
