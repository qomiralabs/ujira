// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The sweep moves a deposit from the forwarding account into the mandate by
// an asset contract transfer. In the relayer form UJIRA's sponsor is the
// transaction source and the principal signs only an authorization entry,
// with a short expiry, for exactly this transfer. The fee bump form is the
// fallback, with the forwarding account as source.

import {
  Address,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-base';
import type { Transaction } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError, SignedPayloadMismatchError } from '../errors.js';

import {
  MAX_SWEEP_AUTH_LEDGERS,
  buildSweepFeeBumpInner,
  buildSweepRelayerTransaction,
  sweepAuthEntry,
} from './funding-sweep.js';
import type { SweepAuthInput, SweepTransactionInput } from './funding-sweep.js';

const NETWORK = 'stellar:testnet' as const;
const pair = (fill: number): Keypair => Keypair.fromRawEd25519Seed(Buffer.alloc(32, fill));
const SPONSOR = pair(1).publicKey();
const FORWARDER = pair(2).publicKey();
const OTHER = pair(3).publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 4));
const MANDATE = StrKey.encodeContract(Buffer.alloc(32, 5));
const OTHER_MANDATE = StrKey.encodeContract(Buffer.alloc(32, 6));
const SOROBAN_DATA = new SorobanDataBuilder().setResourceFee(50_000).build().toXDR('base64');

const AUTH: SweepAuthInput = {
  network: NETWORK,
  token: TOKEN,
  forwarder: FORWARDER,
  mandate: MANDATE,
  amount: 2_500_000n,
  nonce: 77n,
  latestLedger: 1_000,
  expiresInLedgers: 60,
};

const TX: Omit<SweepTransactionInput, 'signedAuthEntry'> = {
  network: NETWORK,
  sponsor: SPONSOR,
  sponsorSequence: 41n,
  token: TOKEN,
  forwarder: FORWARDER,
  mandate: MANDATE,
  amount: 2_500_000n,
  inclusionFee: 100n,
  timeBounds: { minTime: 0n, maxTime: 1_900_000_000n },
  sorobanData: SOROBAN_DATA,
};

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

// What the wallet does: fills in a signature and leaves the rest alone.
function signedEntry(text: string): string {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(text, 'base64');
  entry.credentials().address().signature(xdr.ScVal.scvVec([]));
  return entry.toXDR('base64');
}

function transferArgs(args: xdr.InvokeContractArgs): {
  readonly token: string;
  readonly fn: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
} {
  const [from, to, amount] = args.args();
  return {
    token: Address.fromScAddress(args.contractAddress()).toString(),
    fn: args.functionName().toString(),
    from: from === undefined ? '' : Address.fromScVal(from).toString(),
    to: to === undefined ? '' : Address.fromScVal(to).toString(),
    amount: amount?.i128().lo().toString() ?? '',
  };
}

const WANT = {
  token: TOKEN,
  fn: 'transfer',
  from: FORWARDER,
  to: MANDATE,
  amount: '2500000',
};

describe('sweep.build.test.ts', () => {
  it('relayer form with sponsor as source and principal auth entry', () => {
    const entryText = signedEntry(sweepAuthEntry(AUTH));
    const text = buildSweepRelayerTransaction({ ...TX, signedAuthEntry: entryText });
    const tx = TransactionBuilder.fromXDR(text, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(SPONSOR);
    expect(tx.sequence).toBe('42');
    expect(tx.memo.type).toBe('none');
    const envelope = xdr.TransactionEnvelope.fromXDR(text, 'base64');
    const [op, ...rest] = envelope.v1().tx().operations();
    expect(rest).toEqual([]);
    const invoke = op?.body().invokeHostFunctionOp();
    const host = invoke?.hostFunction().invokeContract();
    expect(host === undefined ? null : transferArgs(host)).toEqual(WANT);
    // The principal's own signed entry goes in untouched, and it alone.
    expect(invoke?.auth().map((a) => a.toXDR('base64'))).toEqual([entryText]);
  });

  it('asks the principal to authorize exactly the transfer, with a short expiry', () => {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(sweepAuthEntry(AUTH), 'base64');
    const credentials = entry.credentials().address();
    expect(Address.fromScAddress(credentials.address()).toString()).toBe(FORWARDER);
    expect(credentials.nonce().toString()).toBe('77');
    expect(credentials.signatureExpirationLedger()).toBe(1_060);
    expect(credentials.signature().switch().name).toBe('scvVoid');
    const root = entry.rootInvocation();
    expect(root.subInvocations()).toEqual([]);
    expect(transferArgs(root.function().contractFn())).toEqual(WANT);
  });

  it('refuses an expiry that is not short, and input it cannot encode', () => {
    expect(() =>
      sweepAuthEntry({ ...AUTH, expiresInLedgers: MAX_SWEEP_AUTH_LEDGERS }),
    ).not.toThrow();
    for (const bad of [
      { ...AUTH, expiresInLedgers: MAX_SWEEP_AUTH_LEDGERS + 1 },
      { ...AUTH, expiresInLedgers: 0 },
      { ...AUTH, latestLedger: -1 },
      { ...AUTH, amount: 0n },
      { ...AUTH, amount: -5n },
      { ...AUTH, amount: 2n ** 127n },
      { ...AUTH, amount: 1 },
      { ...AUTH, nonce: -1n },
      { ...AUTH, forwarder: MANDATE },
      { ...AUTH, mandate: FORWARDER },
      { ...AUTH, token: 'CABC' },
      { ...AUTH, network: 'stellar:mainnet' },
      { ...AUTH, memo: 'x' },
    ]) {
      expect(thrown(() => sweepAuthEntry(bad as never))).toBeInstanceOf(InvalidInputError);
    }
  });

  it('carries the amount in full across the 64 bit boundary', () => {
    const big = 2n ** 70n + 5n;
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(
      sweepAuthEntry({ ...AUTH, amount: big }),
      'base64',
    );
    const amount = entry.rootInvocation().function().contractFn().args()[2]?.i128();
    expect(amount?.lo().toString()).toBe('5');
    expect(amount?.hi().toString()).toBe('64');
  });

  it('refuses a signed entry that is not for this transfer', () => {
    const signed = (over: Partial<SweepAuthInput>): string =>
      signedEntry(sweepAuthEntry({ ...AUTH, ...over }));
    for (const entry of [
      signed({ amount: 1n }),
      signed({ mandate: OTHER_MANDATE }),
      signed({ forwarder: OTHER }),
      signed({ token: OTHER_MANDATE }),
      // Never signed: the wallet handed back what it was given.
      sweepAuthEntry(AUTH),
    ]) {
      expect(
        thrown(() => buildSweepRelayerTransaction({ ...TX, signedAuthEntry: entry })),
      ).toBeInstanceOf(SignedPayloadMismatchError);
    }
    // A sub invocation would let the signature move anything else as well.
    const nested = xdr.SorobanAuthorizationEntry.fromXDR(signed({}), 'base64');
    const child = xdr.SorobanAuthorizationEntry.fromXDR(signed({}), 'base64').rootInvocation();
    nested.rootInvocation().subInvocations([child]);
    expect(
      thrown(() =>
        buildSweepRelayerTransaction({ ...TX, signedAuthEntry: nested.toXDR('base64') }),
      ),
    ).toBeInstanceOf(SignedPayloadMismatchError);
    // Source account credentials would make the sponsor the authorizer.
    const asSource = xdr.SorobanAuthorizationEntry.fromXDR(signed({}), 'base64');
    asSource.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
    expect(
      thrown(() =>
        buildSweepRelayerTransaction({ ...TX, signedAuthEntry: asSource.toXDR('base64') }),
      ),
    ).toBeInstanceOf(SignedPayloadMismatchError);
    expect(
      thrown(() => buildSweepRelayerTransaction({ ...TX, signedAuthEntry: 'not xdr' })),
    ).toBeInstanceOf(InvalidInputError);
  });

  it('refuses transaction input it cannot build from', () => {
    const signedAuthEntry = signedEntry(sweepAuthEntry(AUTH));
    for (const bad of [
      { ...TX, signedAuthEntry, sponsor: FORWARDER },
      { ...TX, signedAuthEntry, sponsorSequence: -1n },
      { ...TX, signedAuthEntry, inclusionFee: 99n },
      { ...TX, signedAuthEntry, timeBounds: { minTime: 0n, maxTime: 0n } },
      { ...TX, signedAuthEntry, timeBounds: { minTime: 9n, maxTime: 5n } },
      { ...TX, signedAuthEntry, sorobanData: 'not xdr' },
      { ...TX, signedAuthEntry, memo: 'x' },
    ]) {
      expect(thrown(() => buildSweepRelayerTransaction(bad as never))).toBeInstanceOf(
        InvalidInputError,
      );
    }
  });

  it('falls back to a fee bump form with the forwarding account as source', () => {
    const text = buildSweepFeeBumpInner({
      network: NETWORK,
      token: TOKEN,
      forwarder: FORWARDER,
      mandate: MANDATE,
      amount: TX.amount,
      inclusionFee: TX.inclusionFee,
      timeBounds: TX.timeBounds,
      sorobanData: SOROBAN_DATA,
      forwarderSequence: 9n,
    });
    const tx = TransactionBuilder.fromXDR(text, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(FORWARDER);
    expect(tx.sequence).toBe('10');
    expect(tx.memo.type).toBe('none');
    const invoke = xdr.TransactionEnvelope.fromXDR(text, 'base64')
      .v1()
      .tx()
      .operations()[0]
      ?.body()
      .invokeHostFunctionOp();
    const host = invoke?.hostFunction().invokeContract();
    expect(host === undefined ? null : transferArgs(host)).toEqual(WANT);
    // The source signature is the authorization, so no separate signature is asked for.
    expect(invoke?.auth().map((a) => a.credentials().switch().name)).toEqual([
      'sorobanCredentialsSourceAccount',
    ]);
    // UJIRA's sponsor can wrap it, so the principal still needs no XLM.
    const bump = TransactionBuilder.buildFeeBumpTransaction(SPONSOR, '200', tx, Networks.TESTNET);
    expect(bump.feeSource).toBe(SPONSOR);
  });
});
