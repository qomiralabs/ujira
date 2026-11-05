// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A sweep is a money move: one per deposit, one prompt, and never a second
// transaction while an earlier one can still land. The chain side here is the
// in-memory ledger and token, so a duplicate on-chain sweep really does fail
// for insufficient balance. The store holds the rules funding_sweeps holds.

import { SubmissionRejectedError } from '@ujira/chain-adapter';
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
import {
  MemorySweepStore,
  RecordingSweepFunding,
  RecordingSweepPrompts,
  RecordingSweepReports,
} from './memory.js';
import {
  FAILED_EXPIRY_MARGIN_MS,
  acceptSweepSignature,
  cancelSweep,
  noteObservedTransfer,
  reconcileSweep,
  recordDeposit,
  retrySweep,
  sendSweep,
} from './sweep.js';
import type {
  DepositEvent,
  SweepChain,
  SweepChainResult,
  SweepEnvelope,
  SweepPorts,
  SweepRoute,
} from './sweep.js';

const PRINCIPAL = '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12';
const PROJECT = '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04';
const SCOPE = { principalId: PRINCIPAL, projectId: PROJECT };
const OTHER = {
  principalId: '0199a1f6-9999-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-8888-7a55-8e21-5b9c7d3e1f04',
};
const SOURCE = '0199a1f6-aaaa-7a55-8e21-5b9c7d3e1f04';
const INSTANCE = '0199a1f6-bbbb-7a55-8e21-5b9c7d3e1f04';
const NETWORK = 'stellar:testnet' as const;
const FORWARDER = accountFromSeed(new Uint8Array(32).fill(1));
const MANDATE = contractAddress(new Uint8Array(32).fill(2));
const TOKEN = contractAddress(new Uint8Array(32).fill(3));
const OP_ID = '4294967297';
const AMOUNT = 2_500_000n;
const usdc = (amount: bigint): TokenAmount => tokenAmount(amount, 'USDC', 'stellar');
const HASH = 'ab'.repeat(32);
const HASH_2 = 'cd'.repeat(32);
const START = new Date('2026-11-01T12:00:00.000Z');
const VALID_UNTIL = new Date(START.getTime() + 300_000);
const PAST_MARGIN = new Date(VALID_UNTIL.getTime() + FAILED_EXPIRY_MARGIN_MS + 1);
const ROUTE: SweepRoute = { forwarder: FORWARDER, mandate: MANDATE, token: TOKEN };

const DEPOSIT: DepositEvent = {
  scope: SCOPE,
  network: NETWORK,
  depositOperationId: OP_ID,
  fundingSourceId: SOURCE,
  mandateInstanceId: INSTANCE,
  route: ROUTE,
  amount: usdc(AMOUNT),
};

const KEY = { scope: SCOPE, network: NETWORK, depositOperationId: OP_ID };
const SIGNED = { ...KEY, signedPayload: HASH };
const OPTIONS = { timeoutMs: 1_000 };

// The chain side over the in-memory token. A payload is its own hash, and a send
// runs the transfer, so a result comes from what really happened.
class LedgerChain implements SweepChain {
  readonly ledger = new FakeLedger({ now: 1_800_000_000n });
  readonly token = new FakeToken(this.ledger, { address: TOKEN, kind: 'contract' });
  readonly sent: string[] = [];
  readonly results = new Map<string, SweepChainResult>();
  envelope: Omit<SweepEnvelope, 'txHash'> = {
    validUntil: VALID_UNTIL,
    authExpiresLedger: 2_000,
  };
  latest = 1_000;
  recordsSince: Date | null = new Date(0);
  failBeforeSending: unknown = null;
  failAfterSending: unknown = null;
  hang = false;
  onSend: () => void = () => undefined;

  describe(signedPayload: string): SweepEnvelope {
    return { txHash: signedPayload, ...this.envelope };
  }

  send(signedPayload: string): Promise<void> {
    if (this.hang) return new Promise(() => undefined);
    if (this.failBeforeSending !== null) {
      const error = this.failBeforeSending as Error;
      this.failBeforeSending = null;
      return Promise.reject(error);
    }
    this.onSend();
    this.sent.push(signedPayload);
    this.#run(signedPayload);
    if (this.failAfterSending !== null) {
      const error = this.failAfterSending as Error;
      this.failAfterSending = null;
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  #run(txHash: string): void {
    try {
      this.token.transfer(FORWARDER, { address: MANDATE, tag: null }, AMOUNT);
      this.results.set(txHash, {
        kind: 'landed',
        ledger: this.latest,
        transfers: [
          { eventIndex: 3, token: TOKEN, from: FORWARDER, to: MANDATE, amount: usdc(AMOUNT) },
        ],
      });
    } catch (err) {
      if (!(err instanceof TokenFailure)) throw err;
      this.results.set(txHash, {
        kind: 'failed',
        ledger: this.latest,
        reason: err.reason === 'insufficient_balance' ? 'insufficient_balance' : 'rejected',
      });
    }
  }

  result(txHash: string): Promise<SweepChainResult> {
    if (this.hang) return new Promise(() => undefined);
    return Promise.resolve(
      this.results.get(txHash) ?? { kind: 'not_found', recordsSince: this.recordsSince },
    );
  }

  latestLedger(): Promise<number> {
    return Promise.resolve(this.latest);
  }
}

let chain: LedgerChain;
let now: Date;
let store: MemorySweepStore;
let prompts: RecordingSweepPrompts;
let reports: RecordingSweepReports;
let funding: RecordingSweepFunding;
let ports: SweepPorts;

beforeEach(() => {
  chain = new LedgerChain();
  chain.token.mint(FORWARDER, AMOUNT);
  now = START;
  const clock = { now: () => now };
  store = new MemorySweepStore(clock);
  prompts = new RecordingSweepPrompts();
  reports = new RecordingSweepReports();
  funding = new RecordingSweepFunding();
  ports = { store, prompts, chain, reports, funding, clock };
});

async function toSubmitted(hash = HASH): Promise<void> {
  await recordDeposit(DEPOSIT, ports);
  await acceptSweepSignature({ ...KEY, signedPayload: hash }, ports);
}

async function toFailedByExpiry(): Promise<void> {
  await toSubmitted();
  now = PAST_MARGIN;
  await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
}

const statusOf = (): string | undefined => store.rowsOf(SCOPE)[0]?.status;

describe('sweep.test.ts', () => {
  describe('recording a deposit', () => {
    it('a repeated deposit event creates one sweep', async () => {
      const first = await recordDeposit(DEPOSIT, ports);
      const second = await recordDeposit(DEPOSIT, ports);
      expect(store.rowsOf(SCOPE)).toHaveLength(1);
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        fundingSourceId: SOURCE,
        mandateInstanceId: INSTANCE,
        depositOperationId: OP_ID,
        status: 'awaiting_signature',
        sweepTxHash: null,
        validUntil: null,
        failedLedger: null,
      });
      expect(first.amount).toEqual(usdc(AMOUNT));
    });

    it('a retried job does not prompt again', async () => {
      await recordDeposit(DEPOSIT, ports);
      await recordDeposit(DEPOSIT, ports);
      await recordDeposit(DEPOSIT, ports);
      expect(prompts.delivered()).toHaveLength(1);
      expect(prompts.delivered()[0]).toMatchObject({
        scope: SCOPE,
        depositOperationId: OP_ID,
        route: ROUTE,
      });
    });

    it('does not prompt for a sweep that has moved on', async () => {
      await toSubmitted();
      const before = prompts.attempts();
      await recordDeposit(DEPOSIT, ports);
      expect(prompts.attempts()).toBe(before);
    });

    it('refuses a deposit recorded under another tenant, and hands nothing over', async () => {
      await recordDeposit(DEPOSIT, ports);
      await expect(recordDeposit({ ...DEPOSIT, scope: OTHER }, ports)).rejects.toBeInstanceOf(
        SweepTenantError,
      );
      expect(store.rowsOf(OTHER)).toEqual([]);
      expect(prompts.delivered()).toHaveLength(1);
    });

    it('finds its own row when a racing attempt inserts it first', async () => {
      const row = await recordDeposit(DEPOSIT, ports);
      store.hideNextRead = true;
      await expect(recordDeposit(DEPOSIT, ports)).resolves.toEqual(row);
    });

    it('refuses a deposit event it cannot trust', async () => {
      const bad: unknown[] = [
        { ...DEPOSIT, depositOperationId: 'abc' },
        { ...DEPOSIT, depositOperationId: '' },
        { ...DEPOSIT, scope: { principalId: 'x', projectId: 'y' } },
        { ...DEPOSIT, network: 'stellar:mainnet' },
        { ...DEPOSIT, fundingSourceId: 'x' },
        { ...DEPOSIT, mandateInstanceId: 'x' },
        { ...DEPOSIT, route: { ...ROUTE, forwarder: '' } },
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
      expect(store.rowsOf(SCOPE)).toEqual([]);
    });
  });

  describe('sending', () => {
    it('submitted is written before the transaction is sent', async () => {
      await recordDeposit(DEPOSIT, ports);
      const row = await acceptSweepSignature(SIGNED, ports);
      // Accepting the signature writes the row and sends nothing: sending is a
      // later job step, with the same hash and time bounds already on the row.
      expect(chain.sent).toEqual([]);
      expect(row.status).toBe('submitted');
      expect(row.sweepTxHash?.toString('hex')).toBe(HASH);
      expect(row.validUntil).toEqual(VALID_UNTIL);
      let statusWhenSent: string | undefined;
      chain.onSend = () => {
        statusWhenSent = statusOf();
      };
      await sendSweep(SIGNED, ports, OPTIONS);
      expect(statusWhenSent).toBe('submitted');
      expect(chain.sent).toEqual([HASH]);
    });

    it('a crash between send and acknowledge sends nothing new', async () => {
      await toSubmitted();
      chain.failAfterSending = new TypeError('socket hang up');
      await expect(sendSweep(SIGNED, ports, OPTIONS)).rejects.toThrow(TypeError);
      expect(statusOf()).toBe('submitted');
      // The retried step looks the hash up and finds it on the network.
      await expect(sendSweep(SIGNED, ports, OPTIONS)).resolves.toBe('already_on_network');
      expect(chain.sent).toEqual([HASH]);
    });

    it('sends the same envelope again when the first never reached the network', async () => {
      await toSubmitted();
      chain.failBeforeSending = new TypeError('connection refused');
      await expect(sendSweep(SIGNED, ports, OPTIONS)).rejects.toThrow(TypeError);
      await expect(sendSweep(SIGNED, ports, OPTIONS)).resolves.toBe('sent');
      expect(chain.sent).toEqual([HASH]);
    });

    it('accepts the same signature twice and writes it once', async () => {
      await toSubmitted();
      const again = await acceptSweepSignature(SIGNED, ports);
      expect(again.status).toBe('submitted');
      expect(chain.sent).toEqual([]);
    });

    it('refuses a second payload while the first can still land', async () => {
      await toSubmitted();
      const other = { ...KEY, signedPayload: HASH_2 };
      await expect(acceptSweepSignature(other, ports)).rejects.toBeInstanceOf(SweepStateError);
      await expect(sendSweep(other, ports, OPTIONS)).rejects.toBeInstanceOf(SweepStateError);
      expect(chain.sent).toEqual([]);
    });

    it('refuses to send anything for a sweep not submitted', async () => {
      await recordDeposit(DEPOSIT, ports);
      await expect(sendSweep(SIGNED, ports, OPTIONS)).rejects.toBeInstanceOf(SweepStateError);
      expect(chain.sent).toEqual([]);
    });

    it('refuses a signature whose time bound has already passed', async () => {
      await recordDeposit(DEPOSIT, ports);
      chain.envelope = { ...chain.envelope, validUntil: new Date(START.getTime() - 1) };
      await expect(acceptSweepSignature(SIGNED, ports)).rejects.toBeInstanceOf(SweepStateError);
      expect(statusOf()).toBe('awaiting_signature');
    });

    it('leaves a refused send submitted, because only the network can end it', async () => {
      await toSubmitted();
      const refused = new SubmissionRejectedError({ network: NETWORK });
      chain.failBeforeSending = refused;
      await expect(sendSweep(SIGNED, ports, OPTIONS)).rejects.toBe(refused);
      expect(statusOf()).toBe('submitted');
    });
  });

  describe('following the network', () => {
    it('settles on the transfer into the mandate, and records what funded it', async () => {
      await toSubmitted();
      await sendSweep(SIGNED, ports, OPTIONS);
      const done = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(done.status).toBe('settled');
      expect(done.sweepTxHash?.toString('hex')).toBe(HASH);
      expect(chain.token.balance(MANDATE)).toBe(AMOUNT);
      expect(chain.token.balance(FORWARDER)).toBe(0n);
      expect(funding.records()).toEqual([
        {
          scope: SCOPE,
          network: NETWORK,
          depositOperationId: OP_ID,
          mandateInstanceId: INSTANCE,
          txHash: HASH,
          eventIndex: 3,
          to: MANDATE,
          amount: usdc(AMOUNT),
        },
      ]);
      expect(reports.events()).toEqual([]);
    });

    it('records the funding once across a crash before the row moves', async () => {
      await toSubmitted();
      await sendSweep(SIGNED, ports, OPTIONS);
      store.failNextSetStatus = new Error('crashed');
      await expect(reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS)).rejects.toThrow(
        'crashed',
      );
      await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(funding.records()).toHaveLength(1);
      expect(statusOf()).toBe('settled');
    });

    it('insufficient balance on a duplicate sweep marks it failed without retry', async () => {
      await recordDeposit(DEPOSIT, ports);
      // The funds already moved under another transaction, such as one the
      // principal built in their own wallet.
      chain.token.transfer(FORWARDER, { address: MANDATE, tag: null }, AMOUNT);
      await acceptSweepSignature(SIGNED, ports);
      await sendSweep(SIGNED, ports, OPTIONS);
      const done = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(done.status).toBe('failed');
      expect(done.failedLedger).toBe(1_000n);
      expect(reports.events()).toEqual([
        {
          principalId: PRINCIPAL,
          projectId: PROJECT,
          network: NETWORK,
          depositOperationId: OP_ID,
          reason: 'insufficient_balance',
        },
      ]);
      // The database allows the move, so the worker has to decline it.
      chain.latest = 9_000;
      const retry = await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(retry).toEqual({ kind: 'declined', reason: 'insufficient_balance' });
      expect(statusOf()).toBe('failed');
      expect(prompts.delivered()).toHaveLength(1);
      expect(chain.sent).toEqual([HASH]);
      expect(chain.token.balance(MANDATE)).toBe(AMOUNT);
    });

    it('passes failedLedger only from the result it read', async () => {
      await toSubmitted();
      chain.results.set(HASH, { kind: 'failed', ledger: 1_234, reason: 'rejected' });
      const done = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(done).toMatchObject({ status: 'failed', failedLedger: 1_234n });
    });

    it('leaves a sweep submitted while its time bound can still apply', async () => {
      await toSubmitted();
      now = new Date(VALID_UNTIL.getTime() + FAILED_EXPIRY_MARGIN_MS - 1);
      const row = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(row.status).toBe('submitted');
      expect(reports.events()).toEqual([]);
    });

    it('fails a sweep the network never saw, once past the time bound and the margin', async () => {
      await toSubmitted();
      now = PAST_MARGIN;
      const row = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(row).toMatchObject({ status: 'failed', failedLedger: null });
      expect(reports.events()[0]?.reason).toBe('expired');
    });

    it('does not call a sweep expired when the node records do not reach back to it', async () => {
      await toSubmitted();
      now = PAST_MARGIN;
      for (const recordsSince of [null, START, new Date(START.getTime() - 1)]) {
        chain.recordsSince = recordsSince;
        const row = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
        expect(row.status).toBe('submitted');
      }
      expect(reports.events()).toEqual([]);
      expect(reports.alerts()).toHaveLength(3);
      expect(reports.alerts()[0]).toEqual({
        principalId: PRINCIPAL,
        projectId: PROJECT,
        network: NETWORK,
        txHash: HASH,
        kind: 'expiry_not_provable',
      });
      // Records reaching back far enough, with the margin, can show it.
      chain.recordsSince = new Date(START.getTime() - FAILED_EXPIRY_MARGIN_MS);
      const row = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(row.status).toBe('failed');
    });

    it('an expired hash that landed is followed, not failed', async () => {
      await toSubmitted();
      await sendSweep(SIGNED, ports, OPTIONS);
      // Well past the clock, but the hash is on the network.
      now = PAST_MARGIN;
      const row = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(row.status).toBe('settled');
      expect(reports.events()).toEqual([]);
    });

    it('never settles a landed transaction without a transfer into this mandate', async () => {
      const good = {
        eventIndex: 1,
        token: TOKEN,
        from: FORWARDER,
        to: MANDATE,
        amount: usdc(AMOUNT),
      };
      const scopes = [
        [],
        [{ ...good, to: FORWARDER }],
        [{ ...good, from: MANDATE }],
        [{ ...good, token: MANDATE }],
        [{ ...good, amount: usdc(1n) }],
      ];
      for (const transfers of scopes) {
        const local = new MemorySweepStore({ now: () => now });
        const here: SweepPorts = { ...ports, store: local };
        await recordDeposit(DEPOSIT, here);
        await acceptSweepSignature(SIGNED, here);
        chain.results.set(HASH, { kind: 'landed', ledger: 77, transfers });
        const done = await reconcileSweep({ ...KEY, route: ROUTE }, here, OPTIONS);
        expect(done).toMatchObject({ status: 'failed', failedLedger: 77n });
        expect(reports.events().at(-1)?.reason).toBe('no_matching_transfer');
      }
      expect(funding.records()).toEqual([]);
    });

    it('returns anything not submitted as it is', async () => {
      await recordDeposit(DEPOSIT, ports);
      const row = await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(row.status).toBe('awaiting_signature');
    });

    it('gives up at the deadline, on a send and on a read, leaving the sweep submitted', async () => {
      await toSubmitted();
      chain.hang = true;
      const quick = { timeoutMs: 20 };
      await expect(sendSweep(SIGNED, ports, quick)).rejects.toMatchObject({
        name: 'SweepTimeoutError',
      });
      await expect(reconcileSweep({ ...KEY, route: ROUTE }, ports, quick)).rejects.toMatchObject({
        name: 'SweepTimeoutError',
      });
      await expect(retrySweep({ ...KEY, route: ROUTE }, ports, quick)).rejects.toBeInstanceOf(
        SweepStateError,
      );
      expect(statusOf()).toBe('submitted');
    });
  });

  describe('going round again', () => {
    it('a retry waits for the earlier authorization to expire', async () => {
      await toFailedByExpiry();
      const delivered = prompts.delivered().length;
      // A failure rolls back and leaves the signed entry's nonce unused, so it
      // could still be carried by another envelope up to its own expiry.
      chain.latest = 2_000;
      await expect(retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS)).resolves.toEqual({
        kind: 'waiting',
        untilLedger: 2_001,
      });
      expect(statusOf()).toBe('failed');
      expect(prompts.delivered()).toHaveLength(delivered);

      chain.latest = 2_001;
      const retried = await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(retried.kind).toBe('retried');
      // The row gives up the old attempt, and the principal is asked once more.
      expect(store.rowsOf(SCOPE)[0]).toMatchObject({
        status: 'awaiting_signature',
        sweepTxHash: null,
        validUntil: null,
        failedLedger: null,
      });
      expect(prompts.delivered()).toHaveLength(delivered + 1);
    });

    it('keeps the entry expiry from the envelope on the row, for the retry to read', async () => {
      await toFailedByExpiry();
      expect(store.rowsOf(SCOPE)[0]?.authExpiresLedger).toBe(2_000n);
    });

    it('takes the expiry of the new entry when it goes round', async () => {
      await toFailedByExpiry();
      chain.latest = 2_001;
      await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(store.rowsOf(SCOPE)[0]?.authExpiresLedger).toBeNull();
      chain.envelope = {
        validUntil: new Date(PAST_MARGIN.getTime() + 300_000),
        authExpiresLedger: 3_000,
      };
      await acceptSweepSignature({ ...KEY, signedPayload: HASH_2 }, ports);
      expect(store.rowsOf(SCOPE)[0]?.authExpiresLedger).toBe(3_000n);
    });

    it('goes round again without waiting when no authorization entry was signed', async () => {
      chain.envelope = { validUntil: VALID_UNTIL, authExpiresLedger: null };
      await toFailedByExpiry();
      const retried = await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(retried.kind).toBe('retried');
    });

    it('prompts once for a retry across a crash before the row moves', async () => {
      await toFailedByExpiry();
      chain.latest = 3_000;
      store.failNextSetStatus = new Error('crashed');
      await expect(retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS)).rejects.toThrow('crashed');
      await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(prompts.delivered()).toHaveLength(2);
      // Asked again after the move, it is already done.
      const again = await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(again.kind).toBe('retried');
      expect(prompts.delivered()).toHaveLength(2);
    });

    it('takes the new signature and sends it after going round', async () => {
      await toFailedByExpiry();
      chain.latest = 2_001;
      await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      chain.envelope = {
        validUntil: new Date(PAST_MARGIN.getTime() + 300_000),
        authExpiresLedger: 3_000,
      };
      const second = { ...KEY, signedPayload: HASH_2 };
      await acceptSweepSignature(second, ports);
      await sendSweep(second, ports, OPTIONS);
      expect(chain.sent).toEqual([HASH_2]);
      await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(statusOf()).toBe('settled');
      expect(chain.token.balance(MANDATE)).toBe(AMOUNT);
    });

    it('declines and alerts when a failed row turns out to have landed', async () => {
      await toFailedByExpiry();
      chain.results.set(HASH, { kind: 'landed', ledger: 500, transfers: [] });
      const retry = await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(retry).toEqual({ kind: 'declined', reason: 'landed' });
      expect(statusOf()).toBe('failed');
      expect(reports.alerts()).toEqual([
        {
          principalId: PRINCIPAL,
          projectId: PROJECT,
          network: NETWORK,
          txHash: HASH,
          kind: 'landed_after_failed',
        },
      ]);
    });

    it('goes round again after a failure the network recorded for another reason', async () => {
      chain.envelope = { validUntil: VALID_UNTIL, authExpiresLedger: 800 };
      await toSubmitted();
      chain.results.set(HASH, { kind: 'failed', ledger: 900, reason: 'rejected' });
      await reconcileSweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      const retried = await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      expect(retried.kind).toBe('retried');
    });

    it('refuses to retry a sweep that has not failed', async () => {
      await toSubmitted();
      await expect(retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS)).rejects.toBeInstanceOf(
        SweepStateError,
      );
    });
  });

  describe('cancelling', () => {
    it('cancels a sweep awaiting its signature, for good', async () => {
      await recordDeposit(DEPOSIT, ports);
      const row = await cancelSweep(KEY, ports);
      expect(row.status).toBe('cancelled');
      await expect(acceptSweepSignature(SIGNED, ports)).rejects.toBeInstanceOf(SweepStateError);
      await expect(retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS)).rejects.toBeInstanceOf(
        SweepStateError,
      );
    });

    it('refuses to cancel a sweep already sent', async () => {
      await toSubmitted();
      await expect(cancelSweep(KEY, ports)).rejects.toBeInstanceOf(SweepStateError);
    });
  });

  describe('transfers the indexer sees', () => {
    const transfer = {
      scope: SCOPE,
      network: NETWORK,
      txHash: HASH,
      eventIndex: 2,
      from: FORWARDER,
      to: MANDATE,
      amount: usdc(AMOUNT),
    };

    it('expects a transfer whose hash is on a submitted or settled row', async () => {
      await toSubmitted();
      const rows = store.rowsOf(SCOPE);
      expect(noteObservedTransfer(transfer, rows, reports)).toBe('expected');
      expect(reports.alerts()).toEqual([]);
    });

    it('alerts when a transfer lands for a row marked failed', async () => {
      await toFailedByExpiry();
      const rows = store.rowsOf(SCOPE);
      expect(noteObservedTransfer(transfer, rows, reports)).toBe('landed_after_failed');
      expect(reports.alerts()[0]?.kind).toBe('landed_after_failed');
    });

    it('alerts on a transfer no row explains, once a retry or a cancel left no hash', async () => {
      await toFailedByExpiry();
      chain.latest = 2_001;
      await retrySweep({ ...KEY, route: ROUTE }, ports, OPTIONS);
      const rows = store.rowsOf(SCOPE);
      expect(rows[0]?.sweepTxHash).toBeNull();
      expect(noteObservedTransfer(transfer, rows, reports)).toBe('unexplained');
      expect(reports.alerts().at(-1)).toEqual({
        principalId: PRINCIPAL,
        projectId: PROJECT,
        network: NETWORK,
        txHash: HASH,
        kind: 'unexplained',
      });
    });
  });

  describe('tenants', () => {
    it('another tenant can neither read nor drive a sweep', async () => {
      await toSubmitted();
      const theirs = { ...KEY, scope: OTHER };
      await expect(
        reconcileSweep({ ...theirs, route: ROUTE }, ports, OPTIONS),
      ).rejects.toBeInstanceOf(SweepStateError);
      await expect(
        sendSweep({ ...theirs, signedPayload: HASH }, ports, OPTIONS),
      ).rejects.toBeInstanceOf(SweepStateError);
      await expect(retrySweep({ ...theirs, route: ROUTE }, ports, OPTIONS)).rejects.toBeInstanceOf(
        SweepStateError,
      );
      await expect(cancelSweep(theirs, ports)).rejects.toBeInstanceOf(SweepStateError);
      expect(chain.sent).toEqual([]);
      expect(store.rowsOf(OTHER)).toEqual([]);
    });
  });

  it('refuses a request or options it cannot use', async () => {
    await expect(acceptSweepSignature({ ...KEY, signedPayload: '' }, ports)).rejects.toBeInstanceOf(
      FundingInputError,
    );
    await expect(sendSweep(SIGNED, ports, { timeoutMs: 0 })).rejects.toBeInstanceOf(
      FundingInputError,
    );
    await expect(
      reconcileSweep({ ...KEY, depositOperationId: 'x', route: ROUTE }, ports, OPTIONS),
    ).rejects.toBeInstanceOf(FundingInputError);
    await expect(
      retrySweep({ ...KEY, authExpiresLedger: 0, route: ROUTE } as never, ports, OPTIONS),
    ).rejects.toBeInstanceOf(FundingInputError);
    await expect(cancelSweep({ ...KEY, network: 'x' as never }, ports)).rejects.toBeInstanceOf(
      FundingInputError,
    );
  });

  it('exports the flow, the errors and the in-memory ports from the package root', () => {
    const root = index as Record<string, unknown>;
    expect(root['recordDeposit']).toBe(recordDeposit);
    expect(root['acceptSweepSignature']).toBe(acceptSweepSignature);
    expect(root['sendSweep']).toBe(sendSweep);
    expect(root['reconcileSweep']).toBe(reconcileSweep);
    expect(root['retrySweep']).toBe(retrySweep);
    expect(root['cancelSweep']).toBe(cancelSweep);
    expect(root['noteObservedTransfer']).toBe(noteObservedTransfer);
    expect(root['SweepStateError']).toBe(SweepStateError);
    expect(root['MemorySweepStore']).toBe(MemorySweepStore);
    expect(index.FUNDING_ERROR_CODES).toContain('SWEEP_STATE');
  });
});

// The moves funding_sweeps allows, written out, and the two rules it holds a
// caller to. The table's own tests pin the database; this pins that the
// in-memory store these tests lean on agrees with it.
describe('the store holds the rules of funding_sweeps', () => {
  const STATUSES = ['awaiting_signature', 'submitted', 'settled', 'failed', 'cancelled'] as const;
  const ALLOWED = new Set([
    'awaiting_signature>submitted',
    'awaiting_signature>cancelled',
    'submitted>settled',
    'submitted>failed',
    'failed>awaiting_signature',
  ]);

  async function rowAt(status: (typeof STATUSES)[number]): Promise<string> {
    const row = await recordDeposit(DEPOSIT, ports);
    const hash = Buffer.from(HASH, 'hex');
    const submit = {
      status: 'submitted',
      sweepTxHash: hash,
      validUntil: VALID_UNTIL,
      authExpiresLedger: null,
    } as const;
    if (status === 'awaiting_signature') return row.id;
    if (status === 'cancelled') {
      await store.setStatus(SCOPE, row.id, { status: 'cancelled' });
      return row.id;
    }
    await store.setStatus(SCOPE, row.id, submit);
    if (status === 'settled') await store.setStatus(SCOPE, row.id, { status: 'settled' });
    if (status === 'failed') {
      await store.setStatus(SCOPE, row.id, { status: 'failed', failedLedger: 5n });
    }
    return row.id;
  }

  it.each(STATUSES.flatMap((from) => STATUSES.filter((to) => to !== from).map((to) => [from, to])))(
    'moves from %s to %s only if the table does',
    async (from, to) => {
      const id = await rowAt(from);
      const move =
        to === 'submitted'
          ? ({
              status: 'submitted',
              sweepTxHash: Buffer.from(HASH_2, 'hex'),
              validUntil: VALID_UNTIL,
              authExpiresLedger: null,
            } as const)
          : to === 'failed'
            ? ({ status: 'failed', failedLedger: 5n } as const)
            : ({ status: to } as { readonly status: 'settled' });
      if (ALLOWED.has(`${from}>${to}`)) {
        await expect(store.setStatus(SCOPE, id, move)).resolves.toBe(true);
      } else {
        await expect(store.setStatus(SCOPE, id, move)).rejects.toBeInstanceOf(SweepStateError);
      }
    },
  );

  it('refuses failed with no ledger inside the margin, and allows it past', async () => {
    const id = await rowAt('submitted');
    const claim = { status: 'failed', failedLedger: null } as const;
    now = new Date(VALID_UNTIL.getTime() + FAILED_EXPIRY_MARGIN_MS - 1);
    await expect(store.setStatus(SCOPE, id, claim)).rejects.toBeInstanceOf(SweepStateError);
    now = new Date(VALID_UNTIL.getTime() + FAILED_EXPIRY_MARGIN_MS);
    await expect(store.setStatus(SCOPE, id, claim)).resolves.toBe(true);
  });

  it('refuses submitted with time bounds already past', async () => {
    const row = await recordDeposit(DEPOSIT, ports);
    await expect(
      store.setStatus(SCOPE, row.id, {
        status: 'submitted',
        sweepTxHash: Buffer.from(HASH, 'hex'),
        validUntil: START,
        authExpiresLedger: null,
      }),
    ).rejects.toBeInstanceOf(SweepStateError);
  });

  it('is unique on the chain and the operation across tenants, and false for a stranger', async () => {
    const row = await recordDeposit(DEPOSIT, ports);
    const again = {
      fundingSourceId: SOURCE,
      mandateInstanceId: INSTANCE,
      depositOperationId: OP_ID,
      amount: usdc(AMOUNT),
    };
    await expect(store.create(OTHER, again)).resolves.toBe('duplicate');
    await expect(store.setStatus(OTHER, row.id, { status: 'cancelled' })).resolves.toBe(false);
    await expect(store.setStatus(SCOPE, 'no-such-id', { status: 'cancelled' })).resolves.toBe(
      false,
    );
  });
});
