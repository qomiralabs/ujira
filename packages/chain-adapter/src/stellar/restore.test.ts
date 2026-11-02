// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import {
  Address,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { parseRawSimulation } from '@stellar/stellar-sdk/rpc';
import type { Api } from '@stellar/stellar-sdk/rpc';
import { describe, expect, it } from 'vitest';

import { SubmissionRejectedError, SubmissionUnknownError } from '../errors.js';
import { archivedKeys, classify } from './restore.js';
import { sym, struct, u64, vec } from './scval.js';
import { NETWORK, NOW, OPTS, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { FIXTURE_USDC, invoked } from './test-rpc.js';
import { instanceKey } from './trust.js';
import { PASSPHRASES } from './tx.js';

function dataKey(contract: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

function putData(t: TestSetup, contract: string, key: xdr.ScVal, val: xdr.ScVal): xdr.LedgerKey {
  const ledgerKey = dataKey(contract, key);
  const data = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: Address.fromString(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
      val,
    }),
  );
  const id = ledgerKey.toXdr('base64');
  t.rpc.entries.set(id, { key: id, xdr: data.toXdr('base64'), lastModifiedLedgerSeq: 1 });
  return ledgerKey;
}

const payoutKey = (n: number) => vec([sym('Payout'), xdr.ScVal.scvBytes(Buffer.alloc(32, n))]);
const record = (expiresAt: bigint) =>
  vec([sym('Record'), struct({ expires_at: u64('expires_at', expiresAt) })]);
const tombstone = () => vec([sym('Tombstone'), struct({ status: xdr.ScVal.scvU32(4) })]);

function operationOf(envelope: string): { type: string; extendTo?: number; keys: string[] } {
  const tx = TransactionBuilder.fromXdr(envelope, PASSPHRASES[NETWORK]) as Transaction;
  const op = tx.operations[0];
  const env = tx.toEnvelope();
  const data =
    env.type === 'envelopeTypeTx' && env.v1.tx.ext.type === 'sorobanData'
      ? env.v1.tx.ext.sorobanData
      : null;
  const footprint = data?.resources.footprint;
  const keys = [...(footprint?.readOnly ?? []), ...(footprint?.readWrite ?? [])].map((k) =>
    k.toXdr('base64'),
  );
  return {
    type: op?.type ?? 'none',
    ...(op?.type === 'extendFootprintTtl' ? { extendTo: op.extendTo } : {}),
    keys,
  };
}

describe('the restore step', { timeout: 30_000 }, () => {
  it('restores archived entries from a channel account, extends them by policy, then prepares', async () => {
    const t = setup();
    const mandate = t.mandate.address.value;
    const instance = instanceKey(mandate);
    const code = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: new Uint8Array(32).fill(1) }),
    );
    const balance = putData(
      t,
      FIXTURE_USDC,
      vec([sym('Balance'), Address.fromString(mandate).toScVal()]),
      xdr.ScVal.scvVoid(),
    );
    const open = putData(t, mandate, payoutKey(1), record(NOW + 1000n));
    const closed = putData(t, mandate, payoutKey(2), tombstone());
    const keys = [instance, code, balance, open, closed];
    let first = true;
    t.rpc.onSimulate = (tx) => {
      if (tx.operations[0]?.type !== 'invokeHostFunction' || !first) return undefined;
      first = false;
      return {
        ...t.rpc.success(tx, xdr.ScVal.scvVoid()),
        restorePreamble: {
          minResourceFee: '1000',
          transactionData: new SorobanDataBuilder().setReadWrite(keys).build().toXdr('base64'),
        },
      };
    };

    const request = await t.adapter.prepareMandateAction(
      {
        scope: t.scope,
        mandate: t.mandate,
        action: { op: 'pause' },
        signer: {
          kind: 'external',
          network: NETWORK,
          role: 'principal',
          address: { network: NETWORK, value: t.principal.publicKey() },
        },
      },
      OPTS,
    );
    expect(request.kind).toBe('stellar_transaction');

    const sent = t.rpc.sent.map(operationOf);
    const id = (k: xdr.LedgerKey) => k.toXdr('base64');
    expect(sent).toEqual([
      { type: 'restoreFootprint', keys: keys.map(id) },
      { type: 'extendFootprintTtl', extendTo: (1000 + 86_400) / 5, keys: [id(open)] },
      {
        type: 'extendFootprintTtl',
        extendTo: 535_680,
        keys: [id(instance), id(code), id(balance)],
      },
    ]);
    const records = [...t.store.submissions.values()];
    expect(records.map((r) => [r.op, r.state, r.signerAddress])).toEqual([
      ['restore', 'landed', t.channel.publicKey()],
      ['ttl_extend', 'landed', t.channel.publicKey()],
      ['ttl_extend', 'landed', t.channel.publicKey()],
    ]);
    expect(records.map((r) => r.sequenceOrNonce)).toEqual([901n, 902n, 903n]);
    expect(t.store.releases).toEqual([
      { leaseId: expect.any(String) as string, sequenceOrNonce: 904n },
    ]);
    // The member's own transaction is simulated again after the restore.
    const pauses = t.rpc.simulated.filter((tx) => tx.operations[0]?.type === 'invokeHostFunction');
    expect(pauses.map((tx) => invoked(tx).fn)).toEqual(['pause', 'pause']);
  });

  it('fails the action when a restore step fails or never shows up', async () => {
    const failed = setup();
    failed.rpc.getTransaction = () => Promise.resolve({ status: 'FAILED', ledger: 9 });
    failed.rpc.onSimulate = (tx) =>
      tx.operations[0]?.type === 'invokeHostFunction' && failed.rpc.sent.length === 0
        ? {
            ...failed.rpc.success(tx, xdr.ScVal.scvVoid()),
            restorePreamble: {
              minResourceFee: '1',
              transactionData: new SorobanDataBuilder()
                .setReadWrite([instanceKey(failed.mandate.address.value)])
                .build()
                .toXdr('base64'),
            },
          }
        : undefined;
    const pause = {
      scope: failed.scope,
      mandate: failed.mandate,
      action: { op: 'pause' } as const,
      signer: {
        kind: 'external',
        network: NETWORK,
        role: 'principal',
        address: { network: NETWORK, value: failed.principal.publicKey() },
      } as const,
    };
    await expect(failed.adapter.prepareMandateAction(pause, OPTS)).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );
    expect([...failed.store.submissions.values()][0]).toMatchObject({
      op: 'restore',
      state: 'failed',
    });
    expect(failed.store.releases).toHaveLength(1);

    const lost = setup();
    lost.rpc.getTransaction = () => Promise.resolve({ status: 'NOT_FOUND' });
    lost.rpc.onSimulate = (tx) =>
      tx.operations[0]?.type === 'invokeHostFunction' && lost.rpc.sent.length === 0
        ? {
            ...lost.rpc.success(tx, xdr.ScVal.scvVoid()),
            restorePreamble: {
              minResourceFee: '1',
              transactionData: new SorobanDataBuilder()
                .setReadWrite([instanceKey(lost.mandate.address.value)])
                .build()
                .toXdr('base64'),
            },
          }
        : undefined;
    await expect(
      lost.adapter.prepareMandateAction(
        {
          ...pause,
          scope: lost.scope,
          mandate: lost.mandate,
          signer: {
            ...pause.signer,
            address: { network: NETWORK, value: lost.principal.publicKey() },
          },
        },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(SubmissionUnknownError);
  });
});

describe('archivedKeys', () => {
  it('reads archived entries from the restore preamble and from the archived index list, once each', () => {
    const a = instanceKey(FIXTURE_USDC);
    const b = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: new Uint8Array(32).fill(2) }),
    );
    const data = new xdr.SorobanTransactionData({
      ext: xdr.SorobanTransactionDataExt.resourceExt(
        new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: [0, 1, 7] }),
      ),
      resources: new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [a, b] }),
        instructions: 0,
        diskReadBytes: 0,
        writeBytes: 0,
      }),
      resourceFee: 0n,
    });
    const raw: Api.RawSimulateTransactionResponse = {
      id: '1',
      latestLedger: 1,
      minResourceFee: '0',
      transactionData: data.toXdr('base64'),
      results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXdr('base64') }],
      restorePreamble: {
        minResourceFee: '0',
        transactionData: new SorobanDataBuilder().setReadWrite([a]).build().toXdr('base64'),
      },
    };
    const keys = archivedKeys(parseRawSimulation(raw) as Api.SimulateTransactionSuccessResponse);
    expect(keys.map((k) => k.toXdr('base64'))).toEqual([a.toXdr('base64'), b.toXdr('base64')]);
  });
});

describe('classify', () => {
  const mandate = Address.contract(Buffer.alloc(32, 9)).toString();
  const target = { mandate, asset: FIXTURE_USDC };

  it('names every kind of entry and treats anything unexpected as other', () => {
    const account = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() }),
    );
    const someoneElse = Address.fromString(Keypair.random().publicKey()).toScVal();
    const cases: [xdr.LedgerKey, xdr.ScVal | undefined, string][] = [
      [account, undefined, 'other'],
      [instanceKey(FIXTURE_USDC), undefined, 'other'],
      [dataKey(FIXTURE_USDC, vec([sym('Balance'), someoneElse])), undefined, 'other'],
      [dataKey(FIXTURE_USDC, vec([sym('Balance')])), undefined, 'other'],
      [dataKey(FIXTURE_USDC, sym('Balance')), undefined, 'other'],
      [dataKey(FIXTURE_USDC, vec([xdr.ScVal.scvU32(1)])), undefined, 'other'],
      [dataKey(mandate, payoutKey(1)), undefined, 'other'],
      [dataKey(mandate, payoutKey(1)), vec([sym('Unknown')]), 'other'],
      [dataKey(mandate, payoutKey(1)), vec([sym('Record')]), 'other'],
      [dataKey(mandate, payoutKey(1)), tombstone(), 'tombstone'],
      [dataKey(mandate, payoutKey(1)), record(5n), 'open_record'],
      [dataKey(mandate, vec([sym('Daily')])), undefined, 'other'],
    ];
    for (const [key, value, kind] of cases) expect(classify(key, value, target).kind).toBe(kind);
  });
});
