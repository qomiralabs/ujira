// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The advance job on the real database and the fake chain, through the same handler a
// pool calls.

import {
  MANDATE_ERRORS,
  MandateRuleError,
  type ChainAdapter,
  type ChainAdapterRegistry,
  type PayoutId,
  type UnixSeconds,
} from '@ujira/chain-adapter';
import { act, ed25519PublicKey, ed25519Sign, sha256 } from '@ujira/chain-adapter/testing';
import {
  payoutAttempts,
  payoutEngine,
  payoutLegs,
  type Payout,
  type PayoutAttempt,
} from '@ujira/db';
import { adminQuery } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorker } from '../worker/start.js';
import {
  newTenant,
  quiet,
  until,
  workerHarness,
  type WorkerHarness,
} from '../worker/testing/support.js';
import { advanceWork, enqueueAdvance, ENGINE_TIMING } from './advance.js';
import type { EngineDeps } from './plan.js';
import {
  engineWorld,
  Killed,
  killing,
  NETWORK,
  ONE_USDC,
  seedTenant,
  TENANT,
  usdc,
  type EngineWorld,
} from './testing/world.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  await seedTenant(harness);
});

afterAll(async () => {
  await harness.close();
});

const attemptsOf = async (payout: Payout): Promise<readonly PayoutAttempt[]> =>
  harness.db.tenant(TENANT).transaction(async (tx) => payoutAttempts.forPayout(tx, payout.id));

const onChainIdOf = (attempt: PayoutAttempt | undefined): string => {
  if (attempt?.onChainPayoutId === null || attempt?.onChainPayoutId === undefined) {
    throw new Error('the attempt has no on-chain id');
  }
  return attempt.onChainPayoutId;
};

// A chain whose pay refuses, and which otherwise answers as normal.
function refusing(registry: ChainAdapterRegistry, error: Error): ChainAdapterRegistry {
  const refuse = (real: ChainAdapter): ChainAdapter =>
    new Proxy(real, {
      get(on, property) {
        if (property === 'pay') return () => Promise.reject(error);
        const value: unknown = Reflect.get(on, property);
        return typeof value === 'function' ? (value as () => unknown).bind(on) : value;
      },
    });
  return {
    get: (network) => refuse(registry.get(network)),
    list: () => registry.list().map(refuse),
  };
}

async function pastDeadline(world: EngineWorld, attempt: PayoutAttempt | undefined): Promise<void> {
  const remaining = (attempt?.deadline.getTime() ?? 0) - (world.deps.now?.() ?? 0);
  await world.h.advance(BigInt(Math.max(0, Math.ceil(remaining / 1_000)) + 60));
}

async function untilPaid(world: EngineWorld, payout: Payout, deps?: EngineDeps): Promise<Payout> {
  return world.drive(payout, { runs: 20, ...(deps === undefined ? {} : { deps }) });
}

describe('payout advance', () => {
  it('single leg payout reaches final', async () => {
    const world = await engineWorld(harness);
    const before = await world.balanceOfRecipient();
    const payout = await world.payout('single-leg', usdc(5n * ONE_USDC));
    const paid = await untilPaid(world, payout);
    expect(paid.status).toBe('paid');
    const [attempt] = await attemptsOf(payout);
    expect(attempt).toMatchObject({ status: 'final', attemptNumber: 1, network: NETWORK });
    expect(attempt?.fee.amount).toBe((5n * ONE_USDC) / 100n);
    const legs = await harness.db
      .tenant(TENANT)
      .transaction(async (tx) => payoutLegs.forAttempt(tx, attempt?.id ?? ''));
    expect(legs.map((leg) => leg.status)).toEqual(['delivered']);
    expect(legs[0]?.chainTxHash).not.toBeNull();
    expect(world.executed(onChainIdOf(attempt))).toBe(1);
    expect((await world.balanceOfRecipient()) - before).toBe(5n * ONE_USDC);
    // Exactly what was asked of the first run again on the last.
    const receiptJobs = await adminQuery(
      harness.database.url,
      `select 1 from graphile_worker.jobs where task_identifier = 'receipt:issue'`,
    );
    expect(receiptJobs.length).toBeGreaterThan(0);
  });

  it('asks the chain nothing more about a payout that has ended', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('ended', usdc(2n * ONE_USDC));
    await untilPaid(world, payout);
    const calls = world.pays.length;
    await world.run(payout);
    expect(world.pays.length).toBe(calls);
  });

  it('files the first job under the mandate, in the transaction given', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('enqueued', usdc(2n * ONE_USDC));
    await harness.db.tenant(TENANT).transaction(async (tx) => {
      await enqueueAdvance(tx, payout);
    });
    const rows = await adminQuery<{ queue_name: string; key: string }>(
      harness.database.url,
      `select queue_name, key from graphile_worker.jobs where key like $1`,
      [`%payout:${payout.id}`],
    );
    expect(rows[0]?.queue_name).toContain(`mandate:${world.mandateId}`);
  });

  describe('a job killed after its write', () => {
    it('pays nothing twice, at every point it can die', async () => {
      const world = await engineWorld(harness);
      // A clean run says how many boundaries there are to die at.
      const measured = killing(world.deps, 0);
      const measuredPayout = await world.payout('kill-measure', usdc(ONE_USDC));
      await untilPaid(world, measuredPayout, measured.deps);
      const points = measured.boundaries();
      expect(points).toBeGreaterThan(5);

      for (let point = 1; point <= points; point += 1) {
        const before = await world.balanceOfRecipient();
        const payout = await world.payout(`kill-${String(point)}`, usdc(ONE_USDC));
        const dying = killing(world.deps, point);
        let killed = false;
        for (let run = 0; run < 25; run += 1) {
          const now = await world.read(payout.id);
          if (now.status === 'paid') break;
          try {
            await world.run(payout, { deps: dying.deps });
          } catch (error) {
            if (!(error instanceof Killed)) throw error;
            killed = true;
          }
          await world.h.advance(6n);
        }
        const attempts = await attemptsOf(payout);
        expect(attempts, `killed at ${String(point)}`).toHaveLength(1);
        expect((await world.read(payout.id)).status).toBe('paid');
        expect(world.executed(onChainIdOf(attempts[0]))).toBe(1);
        expect((await world.balanceOfRecipient()) - before).toBe(ONE_USDC);
        if (dying.boundaries() >= point) expect(killed).toBe(true);
      }
    }, 280_000);

    it('is picked up by a real pool when the first run dies after paying', async () => {
      const world = await engineWorld(harness);
      const before = await world.balanceOfRecipient();
      const payout = await world.payout('kill-pool', usdc(2n * ONE_USDC));
      await harness.db.tenant(TENANT).transaction(async (tx) => {
        await enqueueAdvance(tx, payout);
      });
      // Dies straight after the first call to the chain, as the job would if its process
      // went away. The queue gives the job back and runs it again.
      const dying = killing(world.deps, 3);
      const worker = await startWorker({
        db: harness.db,
        alert: () => undefined,
        logger: quiet,
        crontabEnabled: false,
        concurrency: 1,
        handlers: { payoutAdvance: advanceWork(dying.deps) },
      });
      try {
        await until(
          'the payout to be paid',
          async () => {
            await world.h.advance(6n);
            return (await world.read(payout.id)).status === 'paid';
          },
          55_000,
        );
      } finally {
        await worker.stop();
      }
      expect(dying.boundaries()).toBeGreaterThanOrEqual(3);
      const attempts = await attemptsOf(payout);
      expect(attempts).toHaveLength(1);
      expect(world.executed(onChainIdOf(attempts[0]))).toBe(1);
      expect((await world.balanceOfRecipient()) - before).toBe(2n * ONE_USDC);
    });

    it('two jobs racing the same payout pay once', async () => {
      const world = await engineWorld(harness);
      const before = await world.balanceOfRecipient();
      const payout = await world.payout('race', usdc(2n * ONE_USDC));
      for (let run = 0; run < 10; run += 1) {
        const outcome = await Promise.allSettled([world.run(payout), world.run(payout)]);
        for (const result of outcome) {
          // Losing a race on the chain's own record is a retry, never a second payment.
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(Error);
          }
        }
        await world.h.advance(6n);
        if ((await world.read(payout.id)).status === 'paid') break;
      }
      const attempts = await attemptsOf(payout);
      expect(attempts).toHaveLength(1);
      expect(world.executed(onChainIdOf(attempts[0]))).toBe(1);
      expect((await world.balanceOfRecipient()) - before).toBe(2n * ONE_USDC);
    });
  });

  it('no failover without DeadProof', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('no-failover', usdc(2n * ONE_USDC));
    await world.run(payout);
    const [attempt] = await attemptsOf(payout);
    expect(attempt?.status).toBe('requested');

    // The chain goes away and the deadline passes, so nothing can be read, let alone
    // proven. The attempt holds the payout's one live slot.
    world.h.faults?.chainDown(true);
    await pastDeadline(world, attempt);
    for (let run = 0; run < 3; run += 1) await world.run(payout);
    expect(await attemptsOf(payout)).toHaveLength(1);
    expect((await attemptsOf(payout))[0]?.status).toBe('requested');
    world.h.faults?.chainDown(false);

    const paid = await untilPaid(world, payout);
    const attempts = await attemptsOf(payout);
    expect(attempts).toHaveLength(1);
    expect(paid.status).toBe('paid');
  });

  it('a request never sent gets a new attempt once it is proven dead', async () => {
    const world = await engineWorld(harness);
    const before = await world.balanceOfRecipient();
    const payout = await world.payout('proven-dead', usdc(2n * ONE_USDC));
    // The signer is down, so nothing reaches the chain while the deadline passes.
    world.h.faults?.signerDown(true);
    await world.run(payout);
    const [first] = await attemptsOf(payout);
    expect(first?.status).toBe('created');
    await pastDeadline(world, first);
    world.h.faults?.signerDown(false);
    const paid = await untilPaid(world, payout);
    expect(paid.status).toBe('paid');
    const attempts = await attemptsOf(payout);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['dead', 'final']);
    expect(attempts[0]?.deadProof).toMatchObject({ kind: 'deadline_passed' });
    expect(attempts[0]?.onChainPayoutId).not.toBe(attempts[1]?.onChainPayoutId);
    expect(world.executed(onChainIdOf(attempts[0]))).toBe(0);
    expect(world.executed(onChainIdOf(attempts[1]))).toBe(1);
    expect((await world.balanceOfRecipient()) - before).toBe(2n * ONE_USDC);
  });

  it('gives up after the bounded number of attempts, and says so', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('give-up', usdc(2n * ONE_USDC));
    world.h.faults?.signerDown(true);
    for (let attempt = 0; attempt < ENGINE_TIMING.maxAttempts + 1; attempt += 1) {
      await world.run(payout);
      await pastDeadline(world, (await attemptsOf(payout)).at(-1));
      await world.run(payout);
    }
    const ended = await world.read(payout.id);
    expect(ended.status).toBe('failed');
    expect(await attemptsOf(payout)).toHaveLength(ENGINE_TIMING.maxAttempts);
    expect(
      await harness.db
        .tenant(TENANT)
        .transaction(async (tx) => payoutEngine.refusalCode(tx, payout.id)),
    ).toBe('ATTEMPTS_EXHAUSTED');
    expect(world.alerts).toContainEqual(
      expect.objectContaining({ kind: 'payout_failed', reason: 'ATTEMPTS_EXHAUSTED' }),
    );
  });

  it('waits out an execute with no funds, without using up a try', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('no-funds', usdc(2n * ONE_USDC));
    const short = {
      ...world.deps,
      adapters: refusing(
        world.deps.adapters,
        new MandateRuleError(MANDATE_ERRORS.INSUFFICIENT_FUNDS, 'INSUFFICIENT_FUNDS'),
      ),
    };
    await world.run(payout);
    await world.run(payout, { deps: short });
    expect((await world.read(payout.id)).status).not.toBe('failed');
    const rows = await adminQuery<{ payload: Record<string, string>; run_at: Date }>(
      harness.database.url,
      `select payload, run_at from graphile_worker._private_jobs where key like $1`,
      [`%payout:${payout.id}`],
    );
    expect(rows[0]?.payload['try']).toBeUndefined();
    expect(rows[0]?.run_at.getTime()).toBeGreaterThan(
      Date.now() + (ENGINE_TIMING.waitPollSeconds - 30) * 1_000,
    );
    expect((await untilPaid(world, payout)).status).toBe('paid');
  });

  it('a refusal for a payout the chain never saw fails it, and alerts', async () => {
    const world = await engineWorld(harness, { feeBps: 5_000n });
    const payout = await world.payout('fee-cap', usdc(2n * ONE_USDC));
    const ended = await world.drive(payout, { runs: 3 });
    expect(ended.status).toBe('failed');
    expect(
      await harness.db
        .tenant(TENANT)
        .transaction(async (tx) => payoutEngine.refusalCode(tx, payout.id)),
    ).toBe('FEE_EXCEEDS_CAP');
    expect(world.alerts).toContainEqual(
      expect.objectContaining({ kind: 'payout_failed', payoutId: payout.id }),
    );
  });

  it('a refusal for a payout already on chain stays open for a person', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('on-chain-refusal', usdc(2n * ONE_USDC));
    await world.run(payout);
    const refused = {
      ...world.deps,
      adapters: refusing(
        world.deps.adapters,
        new MandateRuleError(MANDATE_ERRORS.TRANSFER_FAILED, 'TRANSFER_FAILED'),
      ),
    };
    await world.h.advance(6n);
    await world.run(payout, { deps: refused });
    // Not ended: the chain holds a request with funds committed to it. It goes round the
    // bounded retries, which end in a dead letter and a person.
    expect((await world.read(payout.id)).status).not.toBe('failed');
    expect(world.alerts.filter((alert) => alert.kind === 'payout_failed')).toHaveLength(0);
    const rows = await adminQuery<{ payload: Record<string, string> }>(
      harness.database.url,
      `select payload from graphile_worker._private_jobs where key like $1`,
      [`%payout:${payout.id}`],
    );
    expect(rows[0]?.payload['try']).toBe('2');
  });

  it('a network that is down keeps the payout received and retries', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('down', usdc(2n * ONE_USDC));
    world.h.faults?.chainDown(true);
    await world.run(payout);
    const now = await world.read(payout.id);
    expect(now).toMatchObject({ status: 'received', statusReason: 'network_unavailable' });
    expect(await attemptsOf(payout)).toHaveLength(0);
    const rows = await adminQuery<{ payload: { try: string } }>(
      harness.database.url,
      `select payload from graphile_worker._private_jobs where key like $1`,
      [`%payout:${payout.id}`],
    );
    expect(rows[0]?.payload.try).toBe('2');
    world.h.faults?.chainDown(false);
    expect((await untilPaid(world, payout)).status).toBe('paid');
  });

  it('an approval threshold rests the payout until someone approves', async () => {
    const world = await engineWorld(harness, { approvers: 1, approvalThreshold: 0n });
    const payout = await world.payout('pending-approver', usdc(2n * ONE_USDC));
    const rested = await world.drive(payout, { runs: 4 });
    expect(rested.status).toBe('pending_approval');
    const [attempt] = await attemptsOf(payout);
    expect(attempt?.status).toBe('pending_approval');
    const approver = world.m.approvers[0];
    if (approver === undefined) throw new Error('no approver');
    await act(
      world.h,
      world.m.ref,
      { op: 'approve', payoutId: onChainIdOf(attempt) as PayoutId },
      approver,
      'approver',
    );
    await world.h.advance(6n);
    expect((await untilPaid(world, payout)).status).toBe('paid');
  });

  it("an agent's own wallet is asked to sign, and the payout waits for it", async () => {
    const world = await engineWorld(harness);
    const wallet = {
      ...world.deps,
      signerFor: () => ({
        kind: 'external' as const,
        network: NETWORK,
        role: 'agent' as const,
        address: world.h.managedAgent.address,
      }),
    };
    const payout = await world.payout('own-wallet', usdc(2n * ONE_USDC));
    await world.run(payout, { deps: wallet });
    expect((await world.read(payout.id)).status).toBe('routed');
    const [attempt] = await attemptsOf(payout);
    expect(attempt?.status).toBe('created');
    const rows = await adminQuery<{ run_at: Date }>(
      harness.database.url,
      `select run_at from graphile_worker._private_jobs where key like $1`,
      [`%payout:${payout.id}`],
    );
    expect(rows[0]?.run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('a lapsed attested payout gets a new attempt with new attestations', async () => {
    const seed = sha256(new TextEncoder().encode('attester-for-this-test'));
    const asked: number[] = [];
    let lifetime = 600n;
    const attested = await engineWorld(harness, {
      attester: ed25519PublicKey(seed),
      attestationsFor: async (req) => {
        asked.push(req.attemptNumber);
        const m = attested.m;
        const state = await attested.h.adapter.readMandate(
          { scope: req.scope, mandate: m.ref },
          { signal: new AbortController().signal, correlationId: 'test' },
        );
        const until_ = (BigInt(attested.h.world.net.now()) + lifetime) as UnixSeconds;
        const first = m.recipients[0];
        if (first === undefined) throw new Error('no recipient');
        return {
          earliestValidUntil: until_,
          attestations: req.legs.map((leg) => ({
            legIndex: leg.index,
            validUntil: until_,
            signature: ed25519Sign(
              seed,
              attested.h.adapter.attestationMessage({
                mandate: m.ref,
                recipientRef: first.recipientRef,
                countryPolicyHash: state.config.countryPolicyHash,
                policyEpoch: BigInt(state.state.policyEpoch),
                validUntil: until_,
                destination: { address: first.address, tag: null },
              }),
            ),
          })),
        };
      },
    });
    const before = await attested.balanceOfRecipient();
    const payout = await attested.payout('lapse', usdc(2n * ONE_USDC));
    // On chain and approved, and then its attestation runs out before the execute.
    await attested.run(payout);
    const [first] = await attemptsOf(payout);
    expect(first?.status).toBe('requested');
    expect(attested.pays).toHaveLength(1);
    lifetime = 3_000n;
    await attested.h.advance(700n);
    const paid = await attested.drive(payout, { runs: 20 });
    expect(paid.status).toBe('paid');
    const attempts = await attemptsOf(payout);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['dead', 'final']);
    expect(attempts[0]?.deadProof).toMatchObject({ kind: 'payout_lapsed' });
    expect(new Set(asked)).toEqual(new Set([1, 2]));
    expect(attested.executed(onChainIdOf(attempts[0]))).toBe(0);
    expect(attested.executed(onChainIdOf(attempts[1]))).toBe(1);
    expect((await attested.balanceOfRecipient()) - before).toBe(2n * ONE_USDC);
  });

  it("never sees another tenant's payout", async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('tenant', usdc(2n * ONE_USDC));
    const other = await newTenant(harness.db);
    await advanceWork(world.deps)({
      context: other,
      ids: { payoutId: payout.id, mandateId: payout.mandateId },
      tryNumber: 1,
      signal: new AbortController().signal,
    });
    expect(world.pays).toHaveLength(0);
    expect((await world.read(payout.id)).status).toBe('received');
  });
});
