// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The sponsored forwarding account's creation transaction: exactly four
// operations, with the principal's key as the new account and UJIRA's
// sponsor paying. Only a public key ever enters the flow, because a classic
// signer cannot be limited by destination and holding the secret would be
// custody.

import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-base';
import type { Transaction } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError, SignedPayloadMismatchError } from '../errors.js';

import {
  buildForwarderCreation,
  checkForwarderCreation,
  parseForwarderRequest,
} from './forwarder.js';
import type { ForwarderCreationInput } from './forwarder.js';

const NETWORK = 'stellar:testnet' as const;
const pair = (fill: number): Keypair => Keypair.fromRawEd25519Seed(Buffer.alloc(32, fill));
const SPONSOR = pair(1).publicKey();
const FORWARDER = pair(2).publicKey();
const ISSUER = pair(3).publicKey();
const SECRET = pair(2).secret();

const INPUT: ForwarderCreationInput = {
  network: NETWORK,
  sponsor: SPONSOR,
  sponsorSequence: 41n,
  forwarder: FORWARDER,
  asset: { code: 'USDC', issuer: ISSUER },
  feePerOperation: 100n,
  timeBounds: { minTime: 0n, maxTime: 1_900_000_000n },
};

const EXPECTED = {
  network: NETWORK,
  sponsor: SPONSOR,
  forwarder: FORWARDER,
  asset: INPUT.asset,
};

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function decoded(text: string): Transaction {
  return TransactionBuilder.fromXDR(text, Networks.TESTNET) as Transaction;
}

describe('forwarder.create.test.ts', () => {
  it('builds begin, create, trust, end sponsoring', () => {
    const tx = decoded(buildForwarderCreation(INPUT));
    expect(tx.source).toBe(SPONSOR);
    expect(tx.sequence).toBe('42');
    // UJIRA pays: four operations at the configured fee, from the sponsor.
    expect(tx.fee).toBe('400');
    expect(tx.memo.type).toBe('none');
    expect(tx.operations.map((op) => op.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
    const [begin, create, trust, end] = tx.operations;
    expect(begin).toMatchObject({ source: SPONSOR, sponsoredId: FORWARDER });
    // The principal starts with nothing and never needs XLM.
    expect(create).toMatchObject({
      source: SPONSOR,
      destination: FORWARDER,
      startingBalance: '0.0000000',
    });
    expect(trust).toMatchObject({ source: FORWARDER });
    expect(trust).toHaveProperty('line.code', 'USDC');
    expect(trust).toHaveProperty('line.issuer', ISSUER);
    expect(end).toMatchObject({ source: FORWARDER });
  });

  it('the API accepts only a public key', () => {
    expect(parseForwarderRequest({ network: NETWORK, publicKey: FORWARDER })).toEqual({
      network: NETWORK,
      publicKey: FORWARDER,
    });
    for (const bad of [
      { network: NETWORK, publicKey: SECRET },
      { network: NETWORK, publicKey: FORWARDER, secret: SECRET },
      { network: NETWORK, publicKey: FORWARDER, seed: SECRET },
      { network: NETWORK },
      { network: 'stellar:mainnet', publicKey: FORWARDER },
      { network: NETWORK, publicKey: 'CABC' },
      null,
    ]) {
      const err = thrown(() => parseForwarderRequest(bad));
      expect(err).toBeInstanceOf(InvalidInputError);
      // The refusal must not repeat what was sent, least of all a secret.
      expect(JSON.stringify((err as InvalidInputError).toJSON())).not.toContain(SECRET);
    }
    // The builder is as strict as the request.
    for (const bad of [
      { ...INPUT, forwarder: SECRET },
      { ...INPUT, secret: SECRET },
    ]) {
      const err = thrown(() => buildForwarderCreation(bad));
      expect(err).toBeInstanceOf(InvalidInputError);
      expect(JSON.stringify((err as InvalidInputError).toJSON())).not.toContain(SECRET);
    }
  });

  it('refuses input it cannot build from', () => {
    for (const bad of [
      { ...INPUT, sponsor: FORWARDER },
      { ...INPUT, asset: { code: 'usdc!', issuer: ISSUER } },
      { ...INPUT, asset: { code: 'USDC', issuer: 'GABC' } },
      { ...INPUT, sponsorSequence: -1n },
      { ...INPUT, feePerOperation: 99n },
      { ...INPUT, timeBounds: { minTime: 0n, maxTime: 0n } },
      { ...INPUT, timeBounds: { minTime: 9n, maxTime: 5n } },
      { ...INPUT, memo: 'x' },
    ]) {
      expect(thrown(() => buildForwarderCreation(bad as never))).toBeInstanceOf(InvalidInputError);
    }
  });

  describe('the check before the sponsor signs', () => {
    const build = (ops: (b: TransactionBuilder) => TransactionBuilder): string =>
      ops(
        new TransactionBuilder(new Account(SPONSOR, '41'), {
          fee: '100',
          networkPassphrase: Networks.TESTNET,
          timebounds: { minTime: 0, maxTime: 1_900_000_000 },
        }),
      )
        .build()
        .toEnvelope()
        .toXDR('base64');

    it('passes the transaction the builder made', () => {
      expect(() => {
        checkForwarderCreation(buildForwarderCreation(INPUT), EXPECTED);
      }).not.toThrow();
    });

    it('refuses a transaction with an extra operation, such as adding a signer', () => {
      const original = xdr.TransactionEnvelope.fromXDR(buildForwarderCreation(INPUT), 'base64');
      const tx = decoded(buildForwarderCreation(INPUT));
      const extra = build((b) => {
        for (const op of original.v1().tx().operations()) b.addOperation(op);
        return b.addOperation(
          Operation.setOptions({
            source: FORWARDER,
            signer: { ed25519PublicKey: SPONSOR, weight: 1 },
          }),
        );
      });
      expect(tx.operations).toHaveLength(4);
      expect(
        thrown(() => {
          checkForwarderCreation(extra, EXPECTED);
        }),
      ).toBeInstanceOf(SignedPayloadMismatchError);
    });

    it('refuses every near miss of the four operations', () => {
      const stranger = pair(9).publicKey();
      const usdc = new Asset('USDC', ISSUER);
      const begin = (source = SPONSOR, sponsoredId = FORWARDER) =>
        Operation.beginSponsoringFutureReserves({ source, sponsoredId });
      const create = (source = SPONSOR, destination = FORWARDER, startingBalance = '0') =>
        Operation.createAccount({ source, destination, startingBalance });
      const trust = (source = FORWARDER, asset = usdc) => Operation.changeTrust({ source, asset });
      const end = (source = FORWARDER) => Operation.endSponsoringFutureReserves({ source });
      const cases: xdr.Operation[][] = [
        [create(), begin(), trust(), end()],
        [begin(stranger), create(), trust(), end()],
        [begin(SPONSOR, stranger), create(), trust(), end()],
        [begin(), begin(), trust(), end()],
        [begin(), create(stranger), trust(), end()],
        [begin(), create(SPONSOR, stranger), trust(), end()],
        // Any starting balance is XLM moved out of the sponsor.
        [begin(), create(SPONSOR, FORWARDER, '5'), trust(), end()],
        [begin(), create(), create(), end()],
        [begin(), create(), trust(SPONSOR), end()],
        [begin(), create(), trust(FORWARDER, new Asset('EURC', ISSUER)), end()],
        [begin(), create(), trust(), end(SPONSOR)],
        [begin(), create(), trust(), trust()],
        [begin(), create(), trust()],
      ];
      for (const ops of cases) {
        const text = build((b) => {
          for (const op of ops) b.addOperation(op);
          return b;
        });
        expect(
          thrown(() => {
            checkForwarderCreation(text, EXPECTED);
          }),
        ).toBeInstanceOf(SignedPayloadMismatchError);
      }
    });

    it('refuses the wrong forwarder, sponsor or asset', () => {
      const text = buildForwarderCreation(INPUT);
      for (const other of [
        { ...EXPECTED, forwarder: pair(9).publicKey() },
        { ...EXPECTED, sponsor: pair(9).publicKey() },
        { ...EXPECTED, asset: { code: 'USDC', issuer: pair(9).publicKey() } },
        { ...EXPECTED, asset: { code: 'EURC', issuer: ISSUER } },
      ]) {
        expect(
          thrown(() => {
            checkForwarderCreation(text, other);
          }),
        ).toBeInstanceOf(SignedPayloadMismatchError);
      }
    });

    it('refuses a fee bump or text that is not an envelope', () => {
      const bump = TransactionBuilder.buildFeeBumpTransaction(
        SPONSOR,
        '200',
        decoded(buildForwarderCreation(INPUT)),
        Networks.TESTNET,
      )
        .toEnvelope()
        .toXDR('base64');
      expect(
        thrown(() => {
          checkForwarderCreation(bump, EXPECTED);
        }),
      ).toBeInstanceOf(SignedPayloadMismatchError);
      expect(
        thrown(() => {
          checkForwarderCreation('not xdr', EXPECTED);
        }),
      ).toBeInstanceOf(InvalidInputError);
    });
  });
});
