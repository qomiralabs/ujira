// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// After any transaction whose result lists restored entries, a sponsored
// extension runs as its own step, keyed so it happens once per ledger.

import { Address, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import type { Keypair, Transaction } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import type { MandateActionRequest, SigningRequest } from '../types.js';

import { sym, struct, u64, vec } from './scval.js';
import { NETWORK, NOW, OPTS, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { restoredMeta } from './test-results.js';
import { FIXTURE_USDC } from './test-rpc.js';
import { PASSPHRASES } from './tx.js';

function dataEntry(contract: string, key: xdr.ScVal, val: xdr.ScVal): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: Address.fromString(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
      val,
    }),
  );
}

function keyOf(data: xdr.LedgerEntryData): string {
  if (data.type !== 'contractData') throw new Error('expected contract data');
  const { contract, key, durability } = data.contractData;
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract, key, durability }),
  ).toXdr('base64');
}

function put(t: TestSetup, data: xdr.LedgerEntryData): string {
  const key = keyOf(data);
  t.rpc.entries.set(key, { key, xdr: data.toXdr('base64'), lastModifiedLedgerSeq: 1 });
  return key;
}

const payoutKey = (n: number) => vec([sym('Payout'), xdr.ScVal.scvBytes(Buffer.alloc(32, n))]);

function requestOf(t: TestSetup): MandateActionRequest {
  return {
    scope: t.scope,
    mandate: t.mandate,
    action: { op: 'pause' },
    signer: {
      kind: 'external',
      network: NETWORK,
      role: 'principal',
      address: { network: NETWORK, value: t.principal.publicKey() },
    },
  };
}

function sign(request: SigningRequest, key: Keypair): string {
  if (request.kind !== 'stellar_transaction') throw new Error('expected a transaction');
  const tx = TransactionBuilder.fromXdr(request.xdr, PASSPHRASES[NETWORK]);
  tx.sign(key);
  return tx.toXdr();
}

function extensions(t: TestSetup, from: number): { extendTo: number; keys: string[] }[] {
  return t.rpc.sent.slice(from).flatMap((envelope) => {
    const tx = TransactionBuilder.fromXdr(envelope, PASSPHRASES[NETWORK]) as Transaction;
    const op = tx.operations[0];
    if (op?.type !== 'extendFootprintTtl') return [];
    const env = tx.toEnvelope();
    const data =
      env.type === 'envelopeTypeTx' && env.v1.tx.ext.type === 'sorobanData'
        ? env.v1.tx.ext.sorobanData
        : null;
    return [
      {
        extendTo: op.extendTo,
        keys: (data?.resources.footprint.readOnly ?? []).map((k) => k.toXdr('base64')),
      },
    ];
  });
}

async function landedWithRestored(
  t: TestSetup,
  entries: readonly xdr.LedgerEntryData[],
  ledger = 77,
) {
  const req = requestOf(t);
  const request = await t.adapter.prepareMandateAction(req, OPTS);
  const ref = await t.adapter.submitSigned(
    {
      scope: t.scope,
      requestId: request.requestId,
      signed: sign(request, t.principal),
      correlationId: 'c',
    },
    OPTS,
  );
  t.rpc.txs.set(ref.txHash, {
    status: 'SUCCESS',
    ledger,
    resultMetaXdr: restoredMeta(entries),
  });
  return { req, requestId: request.requestId };
}

describe('the extension after a restore', { timeout: 30_000 }, () => {
  it('takes the instance and balance to the horizon, an open record to its expiry plus a day, and leaves a tombstone', async () => {
    const t = setup();
    const mandate = t.mandate.address.value;
    const balance = dataEntry(
      FIXTURE_USDC,
      vec([sym('Balance'), Address.fromString(mandate).toScVal()]),
      xdr.ScVal.scvVoid(),
    );
    const open = dataEntry(
      mandate,
      payoutKey(1),
      vec([sym('Record'), struct({ expires_at: u64('expires_at', NOW + 1_000n) })]),
    );
    const closed = dataEntry(
      mandate,
      payoutKey(2),
      vec([sym('Tombstone'), struct({ status: xdr.ScVal.scvU32(4) })]),
    );
    const [balanceKey, openKey] = [put(t, balance), put(t, open)];
    put(t, closed);

    const { req, requestId } = await landedWithRestored(t, [balance, open, closed]);
    const before = t.rpc.sent.length;
    await expect(t.adapter.signedOutcome(req, requestId, OPTS)).resolves.toMatchObject({
      status: 'landed',
    });

    expect(extensions(t, before)).toEqual([
      // Exactly the expiry plus one day, at five seconds a ledger.
      { extendTo: (1_000 + 86_400) / 5, keys: [openKey] },
      { extendTo: 535_680, keys: [balanceKey] },
    ]);
    // Sponsored by UJIRA, sent from a channel account rather than the principal.
    const ops = [...t.store.submissions.values()]
      .filter((s) => s.op === 'ttl_extend')
      .map((s) => s.signerAddress);
    expect(ops).toEqual([t.channel.publicKey(), t.channel.publicKey()]);
  });

  it('runs once per network, mandate and ledger, however often the outcome is read', async () => {
    const t = setup();
    const open = dataEntry(
      t.mandate.address.value,
      payoutKey(1),
      vec([sym('Record'), struct({ expires_at: u64('expires_at', NOW + 1_000n) })]),
    );
    put(t, open);
    const { req, requestId } = await landedWithRestored(t, [open]);
    const before = t.rpc.sent.length;
    await t.adapter.signedOutcome(req, requestId, OPTS);
    const after = t.rpc.sent.length;
    expect(after).toBeGreaterThan(before);
    await t.adapter.signedOutcome(req, requestId, OPTS);
    expect(t.rpc.sent.length).toBe(after);
  });

  it('extends nothing when the result lists nothing restored', async () => {
    const t = setup();
    const { req, requestId } = await landedWithRestored(t, []);
    const before = t.rpc.sent.length;
    await t.adapter.signedOutcome(req, requestId, OPTS);
    expect(t.rpc.sent.length).toBe(before);
  });
});
