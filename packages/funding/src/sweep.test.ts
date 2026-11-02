// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A sweep is a money move: one per deposit, one prompt, and no retry can
// create a second. The chain side here is the in-memory ledger and token, so
// a duplicate on-chain sweep really does fail for insufficient balance.

import { ChainUnavailableError, SubmissionRejectedError } from '@ujira/chain-adapter';
import {
  FakeLedger,
  FakeToken,
  TokenFailure,
  accountFromSeed,
  contractAddress,
} from '@ujira/chain-adapter/testing';
import { money, tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { FundingInputError, SweepStateError, SweepTenantError } from './errors.js';
import * as index from './index.js';
import { MemorySweepStore, RecordingSweepPrompts, RecordingSweepReports } from './memory.js';
import { reconcileSweep, recordDeposit, submitSweep } from './sweep.js';
import type { DepositEvent, SweepChain, SweepChainResult, SweepPorts } from './sweep.js';

const PRINCIPAL = '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12';
const PROJECT = '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04';
const SCOPE = { principalId: PRINCIPAL, projectId: PROJECT };
const OTHER = {
  principalId: '0199a1f6-9999-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-8888-7a55-8e21-5b9c7d3e1f04',
};
const NETWORK = 'stellar:testnet' as const;
const FORWARDER = accountFromSeed(new Uint8Array(32).fill(1));
const MANDATE = contractAddress(new Uint8Array(32).fill(2));
const TOKEN = contractAddress(new Uint8Array(32).fill(3));
const OP_ID = '4294967297';
const usdc = (amount: bigint): TokenAmount => tokenAmount(amount, 'USDC', 'stellar');
const HASH = 'ab'.repeat(32);

const DEPOSIT: DepositEvent = {
  scope: SCOPE,
  network: NETWORK,
  depositOperationId: OP_ID,
  forwarder: FORWARDER,
  mandate: MANDATE,
  amount: usdc(2_500_000n),
};

const KEY = { scope: SCOPE, network: NETWORK, depositOperationId: OP_ID };

// The chain side over the in-memory token. A submission runs the transfer
// right away, so it is settled or refused by real balances, and a result is
// answered from what happened.
class LedgerChain implements SweepChain {
  readonly ledger = new FakeLedger({ now: 1_800_000_000n });
  readonly token = new FakeToken(this.ledger, { address: TOKEN, kind: 'contract' });
  readonly sent: string[] = [];
  readonly results = new Map<string, SweepChainResult>();
  failSubmit: unknown = null;
  hang = false;
  override: SweepChainResult | null = null;

  hashOf(signedPayload: string): string {
    return signedPayload;
  }

  submit(signedPayload: string): Promise<void> {
    if (this.hang) return new Promise(() => undefined);
    this.sent.push(signedPayload);
    if (this.failSubmit !== null) {
      const error = this.failSubmit as Error;
      this.failSubmit = null;
      return Promise.reject(error);
    }
    this.#run(signedPayload);
    return Promise.resolve();
  }

  #run(txHash: string): void {
    const amount = 2_500_000n;
    try {
      this.token.transfer(FORWARDER, { address: MANDATE, tag: null }, amount);
      this.results.set(txHash, {
        kind: 'landed',
        transfers: [
          { eventIndex: 3, token: TOKEN, from: FORWARDER, to: MANDATE, amount: usdc(amount) },
        ],
      });
    } catch (err) {
      if (!(err instanceof TokenFailure)) throw err;
      this.results.set(txHash, {
        kind: 'failed',
        reason: err.reason === 'insufficient_balance' ? 'insufficient_balance' : 'rejected',
      });
    }
  }

  result(txHash: string): Promise<SweepChainResult> {
    if (this.hang) return new Promise(() => undefined);
    return Promise.resolve(this.override ?? this.results.get(txHash) ?? { kind: 'pending' });
  }
}

let chain: LedgerChain;
let store: MemorySweepStore;
let prompts: RecordingSweepPrompts;
let reports: RecordingSweepReports;
let ports: SweepPorts;
const OPTIONS = { timeoutMs: 1_000, token: TOKEN };

beforeEach(() => {
  chain = new LedgerChain();
  chain.token.mint(FORWARDER, 2_500_000n);
  store = new MemorySweepStore();
  prompts = new RecordingSweepPrompts();
  reports = new RecordingSweepReports();
  ports = { store, prompts, chain, reports };
});

describe('sweep.test.ts', () => {
  it('a repeated deposit event creates one sweep', async () => {
    const first = await recordDeposit(DEPOSIT, ports);
    const second = await recordDeposit(DEPOSIT, ports);
    expect(store.rows()).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      principalId: PRINCIPAL,
      projectId: PROJECT,
      chain: 'stellar',
      network: NETWORK,
      depositOperationId: OP_ID,
      forwarder: FORWARDER,
      mandate: MANDATE,
      status: 'awaiting_signature',
      txHash: null,
    });
    expect(first.amount).toEqual(usdc(2_500_000n));
  });

  it('a retried job does not prompt again', async () => {
    await recordDeposit(DEPOSIT, ports);
    await recordDeposit(DEPOSIT, ports);
    await recordDeposit(DEPOSIT, ports);
    expect(prompts.delivered()).toHaveLength(1);
    expect(prompts.delivered()[0]).toMatchObject({
      scope: SCOPE,
      depositOperationId: OP_ID,
      mandate: MANDATE,
    });
  });

  it('a crash after the prompt and before it is marked still prompts once', async () => {
    store.failNextMarkPrompted = new Error('crashed');
    await expect(recordDeposit(DEPOSIT, ports)).rejects.toThrow('crashed');
    await recordDeposit(DEPOSIT, ports);
    expect(prompts.delivered()).toHaveLength(1);
    expect(prompts.attempts()).toBe(2);
    expect(store.rows()[0]?.promptedAt).not.toBeNull();
  });

  it('does not prompt for a sweep that has moved on', async () => {
    await recordDeposit(DEPOSIT, ports);
    await submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS);
    const before = prompts.attempts();
    await recordDeposit(DEPOSIT, ports);
    expect(prompts.attempts()).toBe(before);
  });

  it('settles a signed sweep, referencing the transfer into the mandate', async () => {
    await recordDeposit(DEPOSIT, ports);
    const sent = await submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS);
    expect(sent).toMatchObject({ status: 'submitted', txHash: HASH });
    expect(chain.sent).toEqual([HASH]);
    const done = await reconcileSweep(KEY, ports, OPTIONS);
    expect(done.status).toBe('confirmed');
    expect(done.funding).toEqual({ txHash: HASH, eventIndex: 3, to: MANDATE });
    expect(chain.token.balance(MANDATE)).toBe(2_500_000n);
    expect(chain.token.balance(FORWARDER)).toBe(0n);
    expect(reports.events()).toEqual([]);
  });

  it('submits once however often it is asked, and refuses a second payload', async () => {
    await recordDeposit(DEPOSIT, ports);
    await submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS);
    const again = await submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS);
    expect(again.status).toBe('submitted');
    expect(chain.sent).toEqual([HASH]);
    await expect(
      submitSweep({ ...KEY, signedPayload: 'cd'.repeat(32) }, ports, OPTIONS),
    ).rejects.toBeInstanceOf(SweepStateError);
    expect(chain.sent).toEqual([HASH]);
  });

  it('insufficient balance on a duplicate sweep marks it failed without retry', async () => {
    await recordDeposit(DEPOSIT, ports);
    // The funds already moved under another transaction, such as one the
    // principal built in their own wallet.
    chain.token.transfer(FORWARDER, { address: MANDATE, tag: null }, 2_500_000n);
    await submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS);
    const done = await reconcileSweep(KEY, ports, OPTIONS);
    expect(done.status).toBe('failed');
    expect(done.failureReason).toBe('insufficient_balance');
    expect(reports.events()).toEqual([
      {
        principalId: PRINCIPAL,
        projectId: PROJECT,
        network: NETWORK,
        depositOperationId: OP_ID,
        reason: 'insufficient_balance',
      },
    ]);
    // Terminal: no retry sends anything or reports twice, and the mandate
    // was funded once.
    await expect(reconcileSweep(KEY, ports, OPTIONS)).resolves.toMatchObject({ status: 'failed' });
    await expect(
      submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS),
    ).rejects.toBeInstanceOf(SweepStateError);
    expect(chain.sent).toEqual([HASH]);
    expect(reports.events()).toHaveLength(1);
    expect(chain.token.balance(MANDATE)).toBe(2_500_000n);
  });

  it('leaves a pending sweep submitted', async () => {
    await recordDeposit(DEPOSIT, ports);
    await submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS);
    chain.override = { kind: 'pending' };
    await expect(reconcileSweep(KEY, ports, OPTIONS)).resolves.toMatchObject({
      status: 'submitted',
    });
  });

  it('never confirms a landed transaction without a transfer into this mandate', async () => {
    const good = {
      eventIndex: 1,
      token: TOKEN,
      from: FORWARDER,
      to: MANDATE,
      amount: usdc(2_500_000n),
    };
    for (const transfers of [
      [],
      [{ ...good, to: FORWARDER }],
      [{ ...good, from: MANDATE }],
      [{ ...good, token: MANDATE }],
      [{ ...good, amount: usdc(1n) }],
    ]) {
      const local = new MemorySweepStore();
      const here: SweepPorts = { ...ports, store: local };
      await recordDeposit(DEPOSIT, here);
      await submitSweep({ ...KEY, signedPayload: HASH }, here, OPTIONS);
      chain.override = { kind: 'landed', transfers };
      const done = await reconcileSweep(KEY, here, OPTIONS);
      expect(done.status).toBe('failed');
      expect(done.failureReason).toBe('no_matching_transfer');
      expect(done.funding).toBeNull();
    }
  });

  it('marks a chain refusal failed, and a definite send failure too', async () => {
    await recordDeposit(DEPOSIT, ports);
    await submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS);
    chain.override = { kind: 'failed', reason: 'rejected' };
    await expect(reconcileSweep(KEY, ports, OPTIONS)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'rejected',
    });
    const local = new MemorySweepStore();
    const here: SweepPorts = { ...ports, store: local };
    await recordDeposit(DEPOSIT, here);
    const refused = new SubmissionRejectedError({ network: NETWORK });
    chain.failSubmit = refused;
    await expect(submitSweep({ ...KEY, signedPayload: HASH }, here, OPTIONS)).rejects.toBe(refused);
    expect(local.rows()[0]).toMatchObject({ status: 'failed', failureReason: 'rejected' });
  });

  it('keeps a sweep submitted when a send may have landed, and never sends it again', async () => {
    await recordDeposit(DEPOSIT, ports);
    chain.failSubmit = new ChainUnavailableError({ network: NETWORK, landed: 'unknown' });
    await expect(
      submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS),
    ).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(store.rows()[0]).toMatchObject({ status: 'submitted', txHash: HASH });
    await submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS);
    expect(chain.sent).toEqual([HASH]);
  });

  it('reads an unexpected send failure as maybe landed', async () => {
    await recordDeposit(DEPOSIT, ports);
    chain.failSubmit = new TypeError('socket hang up');
    await expect(submitSweep({ ...KEY, signedPayload: HASH }, ports, OPTIONS)).rejects.toThrow(
      TypeError,
    );
    expect(store.rows()[0]).toMatchObject({ status: 'submitted', txHash: HASH });
  });

  it('gives up at the deadline, on a send and on a read, leaving the sweep submitted', async () => {
    await recordDeposit(DEPOSIT, ports);
    chain.hang = true;
    const quick = { ...OPTIONS, timeoutMs: 20 };
    await expect(submitSweep({ ...KEY, signedPayload: HASH }, ports, quick)).rejects.toMatchObject({
      name: 'SweepTimeoutError',
    });
    expect(store.rows()[0]).toMatchObject({ status: 'submitted', txHash: HASH });
    await expect(reconcileSweep(KEY, ports, quick)).rejects.toMatchObject({
      name: 'SweepTimeoutError',
    });
    expect(store.rows()[0]?.status).toBe('submitted');
  });

  it('keeps tenants apart: another tenant can neither read nor drive a sweep', async () => {
    await recordDeposit(DEPOSIT, ports);
    const theirs = { ...KEY, scope: OTHER };
    await expect(reconcileSweep(theirs, ports, OPTIONS)).rejects.toBeInstanceOf(SweepStateError);
    await expect(
      submitSweep({ ...theirs, signedPayload: HASH }, ports, OPTIONS),
    ).rejects.toBeInstanceOf(SweepStateError);
    // The deposit id is unique per chain, so a clash across tenants is a
    // fault to surface, never a sweep handed to the wrong tenant.
    await expect(recordDeposit({ ...DEPOSIT, scope: OTHER }, ports)).rejects.toBeInstanceOf(
      SweepTenantError,
    );
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]?.principalId).toBe(PRINCIPAL);
    expect(chain.sent).toEqual([]);
    expect(prompts.delivered()).toHaveLength(1);
  });

  it('refuses a deposit event it cannot trust', async () => {
    const bad: unknown[] = [
      { ...DEPOSIT, depositOperationId: 'abc' },
      { ...DEPOSIT, depositOperationId: '' },
      { ...DEPOSIT, scope: { principalId: 'x', projectId: 'y' } },
      { ...DEPOSIT, network: 'stellar:mainnet' },
      { ...DEPOSIT, forwarder: '' },
      { ...DEPOSIT, mandate: '' },
      { ...DEPOSIT, amount: usdc(0n) },
      { ...DEPOSIT, amount: usdc(-1n) },
      { ...DEPOSIT, amount: 5n },
      { ...DEPOSIT, amount: money(5n, 'USD') },
      // A forged value the money module refuses is refused here too.
      { ...DEPOSIT, amount: { kind: 'token', amount: 1 } },
      { ...DEPOSIT, extra: 1 },
      null,
    ];
    for (const event of bad) {
      await expect(recordDeposit(event as DepositEvent, ports)).rejects.toBeInstanceOf(
        FundingInputError,
      );
    }
    expect(store.rows()).toEqual([]);
  });

  it('refuses a key or options it cannot use', async () => {
    await expect(submitSweep({ ...KEY, signedPayload: '' }, ports, OPTIONS)).rejects.toBeInstanceOf(
      FundingInputError,
    );
    await expect(
      submitSweep({ ...KEY, signedPayload: HASH }, ports, { ...OPTIONS, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(FundingInputError);
    await expect(
      reconcileSweep({ ...KEY, depositOperationId: 'x' }, ports, OPTIONS),
    ).rejects.toBeInstanceOf(FundingInputError);
  });

  it('exports the flow, the errors and the in-memory ports from the package root', () => {
    const root = index as Record<string, unknown>;
    expect(root['recordDeposit']).toBe(recordDeposit);
    expect(root['submitSweep']).toBe(submitSweep);
    expect(root['reconcileSweep']).toBe(reconcileSweep);
    expect(root['SweepStateError']).toBe(SweepStateError);
    expect(root['MemorySweepStore']).toBe(MemorySweepStore);
    expect(index.SWEEP_STATUSES).toEqual([
      'awaiting_signature',
      'submitted',
      'confirmed',
      'failed',
    ]);
    expect(index.FUNDING_ERROR_CODES).toContain('SWEEP_STATE');
  });

  it('holds the store to its uniqueness and its transitions', async () => {
    const row = await recordDeposit(DEPOSIT, ports);
    // The same check the table's unique (chain, deposit_operation_id) will make.
    const clash = await store.insertIfAbsent({ ...row, principalId: OTHER.principalId });
    expect(clash.principalId).toBe(PRINCIPAL);
    await expect(
      store.transition(KEY, 'submitted', { status: 'confirmed' }),
    ).rejects.toBeInstanceOf(SweepStateError);
    await expect(
      store.transition({ ...KEY, depositOperationId: '1' }, 'awaiting_signature', {
        status: 'failed',
      }),
    ).rejects.toBeInstanceOf(SweepStateError);
    await expect(store.markPrompted({ ...KEY, scope: OTHER }, 1n)).rejects.toBeInstanceOf(
      SweepStateError,
    );
  });
});
