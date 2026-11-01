// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the envelope codecs (codecs/envelope.ts, exported from the
 * @ujira/chain-adapter/codecs subpath).
 *
 * decodeTransactionEnvelope(xdr, network) reads a base64 version 1
 * transaction envelope and decodeFeeBumpEnvelope(xdr, network) a fee bump
 * one. Each returns plain data: the source (as written and as the G account
 * behind it), the fee and sequence as bigint, the time bounds, the operation
 * types and sources, the Soroban resource fee, the signatures already on it
 * and the 32 byte hash a signer signs on that network. attachEnvelopeSignature
 * adds one ed25519 signature to the outer envelope and returns the new XDR.
 *
 * Input must be canonical base64 of canonical XDR with nothing after it, no
 * longer than MAX_XDR_BASE64. Anything else, a legacy v0 envelope, the other
 * envelope kind or an unknown network throws InvalidInputError naming the
 * argument, never the value.
 */

import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  hash,
  xdr,
} from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import { ed25519PublicKey, ed25519Sign, ed25519Verify } from '../testing/bytes.js';
import {
  TEST_INNER_SOURCE,
  testFeeBumpXdr,
  testSep10ChallengeXdr,
  testTransactionXdr,
} from '../testing/stellar.js';
import * as codecs from './index.js';
import { MAX_XDR_BASE64 } from './xdr.js';

const {
  MAX_ENVELOPE_SIGNATURES,
  attachEnvelopeSignature,
  decodeFeeBumpEnvelope,
  decodeTransactionEnvelope,
  encodeAccountAddress,
  encodeMuxedAddress,
  networkIdOf,
  networkPassphrase,
} = codecs;

const SEED = new Uint8Array(32).fill(7);
const PUBLIC_KEY = ed25519PublicKey(SEED);
const ADDRESS = encodeAccountAddress(PUBLIC_KEY);
const KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.from(SEED));
const OTHER_SEED = new Uint8Array(32).fill(9);
const OTHER_ADDRESS = encodeAccountAddress(ed25519PublicKey(OTHER_SEED));

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function issuesOf(run: () => unknown): readonly string[] {
  const error = thrown(run);
  expect(error).toBeInstanceOf(InvalidInputError);
  return (error as InvalidInputError).issues;
}

function sign(seed: Uint8Array, hash: Uint8Array) {
  return { publicKey: ed25519PublicKey(seed), signature: ed25519Sign(seed, hash) };
}

describe('network passphrases', () => {
  it('match the Stellar library and hash to the network ID', () => {
    expect(networkPassphrase('stellar:testnet')).toBe(Networks.TESTNET);
    expect(networkPassphrase('stellar:pubnet')).toBe(Networks.PUBLIC);
    // The testnet network ID every Stellar SDK derives from the passphrase.
    expect(Buffer.from(networkIdOf('stellar:testnet')).toString('hex')).toBe(
      'cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472',
    );
    expect(networkIdOf('stellar:pubnet')).toEqual(
      Uint8Array.from(hash(Buffer.from(Networks.PUBLIC))),
    );
  });

  it('refuse a network outside the closed set', () => {
    expect(issuesOf(() => networkPassphrase('stellar:futurenet' as never))).toEqual([
      'network (invalid)',
    ]);
  });
});

describe('transaction envelopes', () => {
  it('round trips a testnet envelope: build, decode, sign, attach and re-parse', () => {
    const unsigned = testTransactionXdr({ source: ADDRESS, sequence: 5000n });
    const decoded = decodeTransactionEnvelope(unsigned, 'stellar:testnet');

    expect(decoded.kind).toBe('transaction');
    expect(decoded.network).toBe('stellar:testnet');
    expect(decoded.source).toEqual({ address: ADDRESS, account: ADDRESS });
    expect(decoded.fee).toBe(100n);
    expect(decoded.sequence).toBe(5000n);
    expect(decoded.timeBounds).toEqual({ minTime: 0n, maxTime: 4_102_444_800n });
    expect(decoded.operations).toEqual([{ type: 'payment', source: null }]);
    expect(decoded.resourceFee).toBeNull();
    expect(decoded.signatures).toEqual([]);

    // The hash is the one the Stellar library signs.
    const reference = new Transaction(unsigned, Networks.TESTNET);
    expect(Buffer.from(decoded.hash).equals(reference.hash())).toBe(true);

    const signed = attachEnvelopeSignature(unsigned, sign(SEED, decoded.hash));
    const reparsed = decodeTransactionEnvelope(signed, 'stellar:testnet');
    expect(reparsed.hash).toEqual(decoded.hash);
    expect(reparsed.signatures).toHaveLength(1);
    const [only] = reparsed.signatures;
    expect(only?.hint).toEqual(PUBLIC_KEY.slice(28));
    expect(ed25519Verify(PUBLIC_KEY, reparsed.hash, only?.signature ?? new Uint8Array())).toBe(
      true,
    );

    // ed25519 is deterministic, so the library signing the same envelope
    // gives byte for byte the same XDR.
    reference.sign(KEYPAIR);
    expect(signed).toBe(reference.toEnvelope().toXDR('base64'));
  });

  it('binds the hash to the network', () => {
    const testnet = testTransactionXdr({ source: ADDRESS, network: 'stellar:testnet' });
    const pubnet = testTransactionXdr({ source: ADDRESS, network: 'stellar:pubnet' });
    expect(testnet).toBe(pubnet);
    const a = decodeTransactionEnvelope(testnet, 'stellar:testnet');
    const b = decodeTransactionEnvelope(pubnet, 'stellar:pubnet');
    expect(a.hash).not.toEqual(b.hash);
    expect(Buffer.from(b.hash).equals(new Transaction(pubnet, Networks.PUBLIC).hash())).toBe(true);
  });

  it('reads a muxed source and an operation source', () => {
    const muxed = encodeMuxedAddress(PUBLIC_KEY, 77n);
    const decoded = decodeTransactionEnvelope(
      testTransactionXdr({ source: muxed, operationSource: OTHER_ADDRESS }),
      'stellar:testnet',
    );
    expect(decoded.source).toEqual({ address: muxed, account: ADDRESS });
    expect(decoded.operations).toEqual([
      { type: 'payment', source: { address: OTHER_ADDRESS, account: OTHER_ADDRESS } },
    ]);
  });

  it('reads a SEP-10 challenge: sequence 0 and manage data from the client', () => {
    const decoded = decodeTransactionEnvelope(
      testSep10ChallengeXdr({ server: OTHER_ADDRESS, client: ADDRESS }),
      'stellar:testnet',
    );
    expect(decoded.sequence).toBe(0n);
    expect(decoded.source.account).toBe(OTHER_ADDRESS);
    expect(decoded.operations).toEqual([
      { type: 'manageData', source: { address: ADDRESS, account: ADDRESS } },
      { type: 'manageData', source: { address: OTHER_ADDRESS, account: OTHER_ADDRESS } },
    ]);
  });

  it('reads no time bounds, version 2 preconditions and a Soroban resource fee', () => {
    const plain = new TransactionBuilder(new Account(ADDRESS, '9'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '20' }))
      .setTimeout(0)
      .build();
    // setTimeout(0) still writes bounds of 0 and 0, so the none form is
    // written by hand.
    const tx = plain.toEnvelope().v1().tx();
    tx.cond(xdr.Preconditions.precondNone());
    const none = plain.toEnvelope();
    none.v1().tx(tx);
    expect(
      decodeTransactionEnvelope(none.toXDR('base64'), 'stellar:testnet').timeBounds,
    ).toBeNull();

    const v2 = new TransactionBuilder(new Account(ADDRESS, '9'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 10, maxTime: 20 },
      minAccountSequenceLedgerGap: 3,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '20' }))
      .build();
    expect(
      decodeTransactionEnvelope(v2.toEnvelope().toXDR('base64'), 'stellar:testnet').timeBounds,
    ).toEqual({ minTime: 10n, maxTime: 20n });

    const v2Unbounded = v2.toEnvelope();
    const inner = v2Unbounded.v1().tx();
    inner.cond().v2().timeBounds(null);
    expect(
      decodeTransactionEnvelope(v2Unbounded.toXDR('base64'), 'stellar:testnet').timeBounds,
    ).toBeNull();

    const soroban = new TransactionBuilder(new Account(ADDRESS, '9'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '20' }))
      .setSorobanData(
        new xdr.SorobanTransactionData({
          ext: new xdr.SorobanTransactionDataExt(0),
          resources: new xdr.SorobanResources({
            footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
            instructions: 1,
            diskReadBytes: 2,
            writeBytes: 3,
          }),
          resourceFee: xdr.Int64.fromString('12345'),
        }),
      )
      .build();
    expect(
      decodeTransactionEnvelope(soroban.toEnvelope().toXDR('base64'), 'stellar:testnet')
        .resourceFee,
    ).toBe(12345n);
  });

  it('is idempotent for a signature already attached, and adds a second signer', () => {
    const unsigned = testTransactionXdr({ source: ADDRESS });
    const { hash } = decodeTransactionEnvelope(unsigned, 'stellar:testnet');
    const once = attachEnvelopeSignature(unsigned, sign(SEED, hash));
    expect(attachEnvelopeSignature(once, sign(SEED, hash))).toBe(once);
    const twice = attachEnvelopeSignature(once, sign(OTHER_SEED, hash));
    expect(decodeTransactionEnvelope(twice, 'stellar:testnet').signatures).toHaveLength(2);
  });

  it('refuses a signature past the network limit', () => {
    let envelope = testTransactionXdr({ source: ADDRESS });
    const { hash } = decodeTransactionEnvelope(envelope, 'stellar:testnet');
    for (let i = 1; i <= MAX_ENVELOPE_SIGNATURES; i += 1) {
      envelope = attachEnvelopeSignature(envelope, sign(new Uint8Array(32).fill(i), hash));
    }
    expect(decodeTransactionEnvelope(envelope, 'stellar:testnet').signatures).toHaveLength(
      MAX_ENVELOPE_SIGNATURES,
    );
    // A key that has not signed yet; any of the twenty would be a no-op.
    const fresh = new Uint8Array(32).fill(200);
    expect(issuesOf(() => attachEnvelopeSignature(envelope, sign(fresh, hash)))).toEqual([
      'xdr (too_many_signatures)',
    ]);
  });

  it.each([
    [
      'a short public key',
      { publicKey: new Uint8Array(31), signature: new Uint8Array(64) },
      'publicKey (invalid_length)',
    ],
    [
      'a short signature',
      { publicKey: new Uint8Array(32), signature: new Uint8Array(63) },
      'signature (invalid_length)',
    ],
    [
      'a public key that is not bytes',
      { publicKey: 'key', signature: new Uint8Array(64) },
      'publicKey (invalid_length)',
    ],
  ])('refuses %s', (_label, signature, issue) => {
    const unsigned = testTransactionXdr({ source: ADDRESS });
    expect(issuesOf(() => attachEnvelopeSignature(unsigned, signature as never))).toEqual([issue]);
  });
});

describe('fee bump envelopes', () => {
  it('round trips a testnet fee bump: build, decode, sign, attach and re-parse', () => {
    const unsigned = testFeeBumpXdr({ feeSource: ADDRESS });
    const decoded = decodeFeeBumpEnvelope(unsigned, 'stellar:testnet');

    expect(decoded.kind).toBe('fee_bump');
    expect(decoded.feeSource).toEqual({ address: ADDRESS, account: ADDRESS });
    // The library sets the outer fee to the base fee times one more than
    // the inner operation count.
    expect(decoded.fee).toBe(400n);
    expect(decoded.inner.source.account).toBe(TEST_INNER_SOURCE);
    expect(decoded.inner.sequence).toBe(7n);
    expect(decoded.inner.operations).toEqual([{ type: 'payment', source: null }]);
    expect(decoded.signatures).toEqual([]);

    const reference = new FeeBumpTransaction(unsigned, Networks.TESTNET);
    expect(Buffer.from(decoded.hash).equals(reference.hash())).toBe(true);
    expect(Buffer.from(decoded.inner.hash).equals(reference.innerTransaction.hash())).toBe(true);

    const signed = attachEnvelopeSignature(unsigned, sign(SEED, decoded.hash));
    const reparsed = decodeFeeBumpEnvelope(signed, 'stellar:testnet');
    const [only] = reparsed.signatures;
    expect(only?.hint).toEqual(PUBLIC_KEY.slice(28));
    expect(ed25519Verify(PUBLIC_KEY, reparsed.hash, only?.signature ?? new Uint8Array())).toBe(
      true,
    );
    // The signature goes on the outer envelope; the inner one is untouched.
    expect(reparsed.inner.signatures).toEqual([]);

    reference.sign(KEYPAIR);
    expect(signed).toBe(reference.toEnvelope().toXDR('base64'));
  });
});

describe('malformed and mismatched input', () => {
  const tx = testTransactionXdr({ source: ADDRESS });
  const bump = testFeeBumpXdr({ feeSource: ADDRESS });

  it('refuses the other envelope kind', () => {
    expect(issuesOf(() => decodeTransactionEnvelope(bump, 'stellar:testnet'))).toEqual([
      'xdr (wrong_envelope_type)',
    ]);
    expect(issuesOf(() => decodeFeeBumpEnvelope(tx, 'stellar:testnet'))).toEqual([
      'xdr (wrong_envelope_type)',
    ]);
  });

  it('refuses a legacy v0 envelope for decoding and signing', () => {
    const v1 = xdr.TransactionEnvelope.fromXDR(tx, 'base64').v1();
    const t = v1.tx();
    const v0 = xdr.TransactionEnvelope.envelopeTypeTxV0(
      new xdr.TransactionV0Envelope({
        tx: new xdr.TransactionV0({
          sourceAccountEd25519: t.sourceAccount().ed25519(),
          fee: t.fee(),
          seqNum: t.seqNum(),
          timeBounds: t.cond().timeBounds(),
          memo: t.memo(),
          operations: t.operations(),
          ext: new xdr.TransactionV0Ext(0),
        }),
        signatures: [],
      }),
    ).toXDR('base64');
    expect(issuesOf(() => decodeTransactionEnvelope(v0, 'stellar:testnet'))).toEqual([
      'xdr (wrong_envelope_type)',
    ]);
    expect(issuesOf(() => decodeFeeBumpEnvelope(v0, 'stellar:testnet'))).toEqual([
      'xdr (wrong_envelope_type)',
    ]);
    expect(issuesOf(() => attachEnvelopeSignature(v0, sign(SEED, new Uint8Array(32))))).toEqual([
      'xdr (wrong_envelope_type)',
    ]);
  });

  it.each([
    ['an empty string', ''],
    ['text that is not base64', 'not base64!'],
    ['base64 that is not an envelope', Buffer.from('hello world').toString('base64')],
    [
      'a trailing byte',
      Buffer.concat([Buffer.from(tx, 'base64'), Buffer.of(0)]).toString('base64'),
    ],
    ['a missing byte', Buffer.from(tx, 'base64').subarray(1).toString('base64')],
    ['whitespace', `${tx}\n`],
    ['url safe base64', tx.replaceAll('+', '-').replaceAll('/', '_') + '-'],
    ['a value that is not a string', 42],
  ])('refuses %s', (_label, input) => {
    expect(issuesOf(() => decodeTransactionEnvelope(input as string, 'stellar:testnet'))).toEqual([
      'xdr (malformed)',
    ]);
  });

  it('refuses base64 whose padding bits are not zero', () => {
    // The last character carries unused low bits; setting one gives text
    // that decodes to the same bytes but is not the canonical form.
    const bytes = Buffer.from(tx, 'base64');
    const trimmed = bytes.subarray(0, bytes.length - (bytes.length % 3 === 0 ? 1 : 0));
    const text = trimmed.toString('base64');
    expect(text.endsWith('=')).toBe(true);
    const at = text.indexOf('=') - 1;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bumped =
      text.slice(0, at) +
      alphabet.charAt(alphabet.indexOf(text.charAt(at)) + 1) +
      text.slice(at + 1);
    expect(Buffer.from(bumped, 'base64').equals(trimmed)).toBe(true);
    expect(issuesOf(() => decodeTransactionEnvelope(bumped, 'stellar:testnet'))).toEqual([
      'xdr (malformed)',
    ]);
  });

  it('refuses input past the size bound before reading it', () => {
    const long = 'A'.repeat(MAX_XDR_BASE64 + 4);
    expect(issuesOf(() => decodeTransactionEnvelope(long, 'stellar:testnet'))).toEqual([
      'xdr (too_long)',
    ]);
    expect(issuesOf(() => attachEnvelopeSignature(long, sign(SEED, new Uint8Array(32))))).toEqual([
      'xdr (too_long)',
    ]);
  });

  it('refuses an unknown network before reading the envelope', () => {
    expect(issuesOf(() => decodeTransactionEnvelope(tx, 'stellar:mainnet' as never))).toEqual([
      'network (invalid)',
    ]);
    expect(issuesOf(() => decodeFeeBumpEnvelope(bump, 'eip155:1' as never))).toEqual([
      'network (invalid)',
    ]);
  });

  it('never puts the input in the error', () => {
    const secret = Buffer.from('a value that must not leak').toString('base64');
    const error = thrown(() => decodeTransactionEnvelope(secret, 'stellar:testnet'));
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });
});
