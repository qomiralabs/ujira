// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the sweep worker is told about a transaction, over the adapter's fake RPC
// and metadata written as the network writes it. Reading a landed transaction as
// one that moved nothing is what could lead to a second sweep, so what cannot be
// read has to be an error.

import { Address, xdr } from '@stellar/stellar-sdk/base';
import { Keypair, SorobanDataBuilder, StrKey } from '@stellar/stellar-base';
import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { ChainUnavailableError, SubmissionRejectedError } from '../errors.js';

import { buildSweepFeeBumpInner } from './funding-sweep.js';
import { createStellarSweepChain } from './funding-sweep-chain.js';
import { NETWORK, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { address, i128, struct, sym } from './scval.js';

const FORWARDER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const MANDATE = StrKey.encodeContract(Buffer.alloc(32, 5));
const LOOKALIKE = StrKey.encodeContract(Buffer.alloc(32, 6));
const HASH = 'ab'.repeat(32);
const ABORT = new AbortController().signal;
const FIXTURE_USDC = setup().ports.config()[NETWORK]?.assets.USDC.sac ?? '';

function chainOver(t: TestSetup) {
  return createStellarSweepChain({
    network: NETWORK,
    rpc: t.rpc,
    ports: t.ports,
    submitTimeoutMs: 1_000,
  });
}

function contractEvent(
  source: string,
  topics: readonly xdr.ScVal[],
  data: xdr.ScVal,
): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: new xdr.ContractId(Address.fromString(source).toBuffer()),
    type: xdr.ContractEventType.contract,
    body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [...topics], data })),
  });
}

function transfer(source: string, amount: bigint, to = MANDATE): xdr.ContractEvent {
  return contractEvent(
    source,
    [sym('transfer'), address('from', FORWARDER), address('to', to)],
    i128('amount', amount),
  );
}

function metaV4(
  events: readonly xdr.ContractEvent[],
  diagnostics: readonly xdr.DiagnosticEvent[] = [],
): string {
  return xdr.TransactionMeta.v4(
    new xdr.TransactionMetaV4({
      ext: xdr.ExtensionPoint.v0(),
      txChangesBefore: [],
      operations: [
        new xdr.OperationMetaV2({
          ext: xdr.ExtensionPoint.v0(),
          changes: [],
          events: [...events],
        }),
      ],
      txChangesAfter: [],
      sorobanMeta: null,
      events: [],
      diagnosticEvents: [...diagnostics],
    }),
  ).toXdr('base64');
}

function contractError(source: string, code: number): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: contractEvent(
      source,
      [sym('error'), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
      xdr.ScVal.scvVoid(),
    ),
  });
}

function signedEnvelope(): string {
  return buildSweepFeeBumpInner({
    network: NETWORK,
    token: FIXTURE_USDC,
    forwarder: FORWARDER,
    mandate: MANDATE,
    amount: 2_500_000n,
    inclusionFee: 100n,
    timeBounds: { minTime: 0n, maxTime: 1_900_000_000n },
    sorobanData: new SorobanDataBuilder().setResourceFee(50_000).build().toXDR('base64'),
    forwarderSequence: 41n,
  });
}

describe('funding-sweep-chain.test.ts', () => {
  describe('describe', () => {
    it('reads the hash and the time bound from the envelope', () => {
      const facts = chainOver(setup()).describe(signedEnvelope());
      expect(facts.txHash).toMatch(/^[0-9a-f]{64}$/);
      expect(facts.validUntil).toEqual(new Date(1_900_000_000_000));
      expect(facts.authExpiresLedger).toBeNull();
    });
  });

  describe('result', () => {
    it('reads the transfers the asset contract reported', async () => {
      const t = setup();
      t.rpc.txs.set(HASH, {
        status: 'SUCCESS',
        ledger: 77,
        resultMetaXdr: metaV4([transfer(FIXTURE_USDC, 2_500_000n)]),
      });
      expect(await chainOver(t).result(HASH, ABORT)).toEqual({
        kind: 'landed',
        ledger: 77,
        transfers: [
          {
            eventIndex: 0,
            token: FIXTURE_USDC,
            from: FORWARDER,
            to: MANDATE,
            amount: tokenAmount(2_500_000n, 'USDC', 'stellar'),
          },
        ],
      });
    });

    it('reads an amount held beside a muxed destination', async () => {
      const t = setup();
      const data = struct({ amount: i128('amount', 9n), to_muxed_id: xdr.ScVal.scvVoid() });
      t.rpc.txs.set(HASH, {
        status: 'SUCCESS',
        ledger: 77,
        resultMetaXdr: metaV4([
          contractEvent(
            FIXTURE_USDC,
            [sym('transfer'), address('from', FORWARDER), address('to', MANDATE)],
            data,
          ),
        ]),
      });
      const answer = await chainOver(t).result(HASH, ABORT);
      expect(answer).toMatchObject({
        transfers: [{ amount: tokenAmount(9n, 'USDC', 'stellar') }],
      });
    });

    it('does not take another contract saying it made a transfer for one', async () => {
      const t = setup();
      t.rpc.txs.set(HASH, {
        status: 'SUCCESS',
        ledger: 77,
        resultMetaXdr: metaV4([
          transfer(LOOKALIKE, 2_500_000n),
          contractEvent(FIXTURE_USDC, [sym('mint')], i128('amount', 1n)),
          contractEvent(FIXTURE_USDC, [sym('transfer')], i128('amount', 1n)),
          transfer(FIXTURE_USDC, 5n),
        ]),
      });
      const answer = await chainOver(t).result(HASH, ABORT);
      expect(answer).toMatchObject({ transfers: [{ eventIndex: 3 }] });
    });

    it('reads metadata of the previous version too', async () => {
      const t = setup();
      const v3 = xdr.TransactionMeta.v3(
        new xdr.TransactionMetaV3({
          ext: xdr.ExtensionPoint.v0(),
          txChangesBefore: [],
          operations: [],
          txChangesAfter: [],
          sorobanMeta: new xdr.SorobanTransactionMeta({
            ext: xdr.SorobanTransactionMetaExt.v0(),
            events: [transfer(FIXTURE_USDC, 5n)],
            returnValue: xdr.ScVal.scvVoid(),
            diagnosticEvents: [],
          }),
        }),
      ).toXdr('base64');
      t.rpc.txs.set(HASH, { status: 'SUCCESS', ledger: 77, resultMetaXdr: v3 });
      expect(await chainOver(t).result(HASH, ABORT)).toMatchObject({
        transfers: [{ eventIndex: 0 }],
      });
    });

    it('never reads a landed transaction it cannot read as one that moved nothing', async () => {
      const t = setup();
      const chain = chainOver(t);
      t.rpc.txs.set(HASH, { status: 'SUCCESS', ledger: 77 });
      await expect(chain.result(HASH, ABORT)).rejects.toBeInstanceOf(ChainUnavailableError);
      t.rpc.txs.set(HASH, { status: 'SUCCESS', ledger: 77, resultMetaXdr: 'bm90IHhkcg==' });
      await expect(chain.result(HASH, ABORT)).rejects.toBeInstanceOf(ChainUnavailableError);
      t.rpc.txs.set(HASH, { status: 'SUCCESS', resultMetaXdr: metaV4([]) });
      await expect(chain.result(HASH, ABORT)).rejects.toBeInstanceOf(ChainUnavailableError);
    });

    it('names insufficient balance only from the asset contract itself', async () => {
      const t = setup();
      const chain = chainOver(t);
      const failed = (diagnostics: readonly xdr.DiagnosticEvent[]) => ({
        status: 'FAILED' as const,
        ledger: 9,
        resultMetaXdr: metaV4([], diagnostics),
      });
      t.rpc.txs.set(HASH, failed([contractError(FIXTURE_USDC, 10)]));
      expect(await chain.result(HASH, ABORT)).toEqual({
        kind: 'failed',
        ledger: 9,
        reason: 'insufficient_balance',
      });
      for (const diagnostics of [
        [],
        [contractError(FIXTURE_USDC, 13)],
        [contractError(LOOKALIKE, 10)],
      ]) {
        t.rpc.txs.set(HASH, failed(diagnostics));
        expect(await chain.result(HASH, ABORT)).toMatchObject({ reason: 'rejected' });
      }
    });

    it('reads a failure with no metadata as rejected', async () => {
      const t = setup();
      t.rpc.txs.set(HASH, { status: 'FAILED', ledger: 9 });
      expect(await chainOver(t).result(HASH, ABORT)).toMatchObject({
        kind: 'failed',
        reason: 'rejected',
      });
    });

    it('says how far back a not found reaches, when the node does', async () => {
      const t = setup();
      const chain = chainOver(t);
      t.rpc.txs.set(HASH, { status: 'NOT_FOUND', oldestLedgerCloseTime: 1_800_000_000n });
      expect(await chain.result(HASH, ABORT)).toEqual({
        kind: 'not_found',
        recordsSince: new Date(1_800_000_000_000),
      });
      t.rpc.txs.set(HASH, { status: 'NOT_FOUND' });
      expect(await chain.result(HASH, ABORT)).toEqual({ kind: 'not_found', recordsSince: null });
    });

    it('refuses a network it has no configuration for', async () => {
      const t = setup();
      const chain = createStellarSweepChain({
        network: 'stellar:pubnet',
        rpc: t.rpc,
        ports: t.ports,
        submitTimeoutMs: 1_000,
      });
      t.rpc.txs.set(HASH, { status: 'FAILED', ledger: 9 });
      await expect(chain.result(HASH, ABORT)).rejects.toBeInstanceOf(ChainUnavailableError);
    });
  });

  describe('send', () => {
    it('sends the envelope as it was signed', async () => {
      const t = setup();
      const envelope = signedEnvelope();
      await chainOver(t).send(envelope, ABORT);
      expect(t.rpc.sent).toEqual([envelope]);
    });

    it('takes a duplicate as sent, since it can only be this same envelope', async () => {
      const t = setup();
      t.rpc.sendResult = () => ({ status: 'DUPLICATE', hash: HASH });
      await expect(chainOver(t).send(signedEnvelope(), ABORT)).resolves.toBeUndefined();
    });

    it('reports a busy node and a refusal apart', async () => {
      const t = setup();
      const chain = chainOver(t);
      t.rpc.sendResult = () => ({ status: 'TRY_AGAIN_LATER', hash: HASH });
      await expect(chain.send(signedEnvelope(), ABORT)).rejects.toBeInstanceOf(
        ChainUnavailableError,
      );
      t.rpc.sendResult = () => ({ status: 'ERROR', hash: HASH });
      await expect(chain.send(signedEnvelope(), ABORT)).rejects.toBeInstanceOf(
        SubmissionRejectedError,
      );
    });
  });

  it('reads the latest ledger', async () => {
    const t = setup();
    t.rpc.latest = { ...t.rpc.latest, sequence: 4_242 };
    expect(await chainOver(t).latestLedger(ABORT)).toBe(4_242);
  });
});
