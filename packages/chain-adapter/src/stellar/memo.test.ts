// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The network refuses any transaction that runs contract code and carries a
// memo. These tests pin that no contract call the adapter builds has one,
// that a memo is refused when a transaction is built or wrapped, and that
// the same check runs right before anything is sent.

import {
  Account,
  Address,
  Asset,
  Keypair,
  Memo,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  Networks,
  xdr,
} from '@stellar/stellar-base';
import type { Transaction } from '@stellar/stellar-base';
import { describe, expect, it, vi } from 'vitest';

import { CONTRACT_OPERATION_TYPES, assertNoMemoOnContractCall } from '../codecs/index.js';
import {
  InvalidInputError,
  MemoOnContractCallError,
  RpcTimeoutError,
  SubmissionRejectedError,
  SubmissionUnknownError,
} from '../errors.js';
import * as index from '../index.js';

import {
  MANDATE_FUNCTIONS,
  buildContractCallTransaction,
  extendTtl,
  factoryCreate,
  fundingTransfer,
  mandateCall,
  restoreArchived,
  wrapInFeeBump,
} from './contract-call.js';
import type { ContractCall, ContractCallTransactionInput } from './contract-call.js';
import { relayerRequest, submitEnvelope } from './submit.js';
import type { EnvelopeTransport } from './submit.js';

const NETWORK = 'stellar:testnet';
const PASSPHRASE = Networks.TESTNET;
const SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const SPONSOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const MANDATE = StrKey.encodeContract(Buffer.alloc(32, 3));
const FACTORY = StrKey.encodeContract(Buffer.alloc(32, 4));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 5));
const SOROBAN_DATA = new SorobanDataBuilder().setResourceFee(50_000).build().toXDR('base64');

function input(call: ContractCall): ContractCallTransactionInput {
  return {
    network: NETWORK,
    source: SOURCE,
    sequence: 41n,
    inclusionFee: 100n,
    timeBounds: { minTime: 0n, maxTime: 1_900_000_000n },
    sorobanData: SOROBAN_DATA,
    call,
  };
}

function envelopeOf(text: string): xdr.TransactionEnvelope {
  return xdr.TransactionEnvelope.fromXDR(text, 'base64');
}

function memoName(envelope: xdr.TransactionEnvelope): string {
  const name = envelope.switch().name;
  if (name === 'envelopeTypeTxFeeBump') {
    return envelope.feeBump().tx().innerTx().v1().tx().memo().switch().name;
  }
  return envelope.v1().tx().memo().switch().name;
}

// A transaction put together by hand, the way code outside the builder
// could, so the memo the builder never sets is there to be caught.
function handBuilt(operation: xdr.Operation, memo: Memo): Transaction {
  return new TransactionBuilder(new Account(SOURCE, '41'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
    memo,
    timebounds: { minTime: 0, maxTime: 1_900_000_000 },
    sorobanData: SOROBAN_DATA,
  })
    .addOperation(operation)
    .build();
}

const invoke = (): xdr.Operation =>
  Operation.invokeContractFunction({ contract: MANDATE, function: 'execute', args: [] });

const MEMOS: [string, Memo][] = [
  ['text', Memo.text('order 1234')],
  ['id', Memo.id('1234')],
  ['hash', Memo.hash(Buffer.alloc(32, 7))],
  ['return', Memo.return(Buffer.alloc(32, 8).toString('hex'))],
];

const CONTRACT_OPERATIONS: [string, () => xdr.Operation][] = [
  ['invokeHostFunction', invoke],
  ['extendFootprintTtl', () => Operation.extendFootprintTtl({ extendTo: 1000 })],
  ['restoreFootprint', () => Operation.restoreFootprint({})],
];

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

// Every action the adapter sends to a contract, from the issue's list, with
// the builder that makes it.
const BUILDERS: [string, ContractCall][] = [
  ...MANDATE_FUNCTIONS.map((fn): [string, ContractCall] => [fn, mandateCall(MANDATE, fn, [])]),
  ['create', factoryCreate(FACTORY, [])],
  ['funding transfer', fundingTransfer({ token: TOKEN, from: SOURCE, to: MANDATE, amount: 10n })],
  ['TTL extension', extendTtl(100_000)],
  ['restore', restoreArchived()],
];

describe('memo.test.ts', () => {
  it('covers every contract call the adapter sends', () => {
    for (const fn of [
      'request_payout',
      'request_payouts',
      'approve',
      'execute',
      'execute_batch',
      'pause',
      'revoke',
      'withdraw',
      'sweep',
    ]) {
      expect(MANDATE_FUNCTIONS).toContain(fn);
    }
    expect(Object.isFrozen(MANDATE_FUNCTIONS)).toBe(true);
  });

  it.each(BUILDERS)('every contract call builder produces memo none: %s', (_name, call) => {
    const envelope = envelopeOf(buildContractCallTransaction(input(call)));
    expect(envelope.switch().name).toBe('envelopeTypeTx');
    expect(memoName(envelope)).toBe('memoNone');
    const [operation, ...rest] = envelope.v1().tx().operations();
    expect(rest).toEqual([]);
    expect(CONTRACT_OPERATION_TYPES).toContain(operation?.body().switch().name);
  });

  it('builds the call it was given: function, arguments, source, sequence and fee', () => {
    const call = fundingTransfer({ token: TOKEN, from: SOURCE, to: MANDATE, amount: 10n });
    const tx = envelopeOf(buildContractCallTransaction(input(call)))
      .v1()
      .tx();
    expect(StrKey.encodeEd25519PublicKey(tx.sourceAccount().ed25519())).toBe(SOURCE);
    expect(tx.seqNum().toString()).toBe('42');
    // Inclusion fee plus the simulated resource fee.
    expect(tx.fee()).toBe(50_100);
    const fn = tx.operations()[0]?.body().invokeHostFunctionOp().hostFunction().invokeContract();
    expect(fn?.functionName().toString()).toBe('transfer');
    expect(fn?.args().map((arg) => arg.switch().name)).toEqual([
      'scvAddress',
      'scvAddress',
      'scvI128',
    ]);
  });

  it('throws MemoOnContractCallError for text, id, hash and return memos', () => {
    for (const [, memo] of MEMOS) {
      for (const [, operation] of CONTRACT_OPERATIONS) {
        const text = handBuilt(operation(), memo).toEnvelope().toXDR('base64');
        const err = thrown(() => {
          assertNoMemoOnContractCall(text, NETWORK);
        });
        expect(err).toBeInstanceOf(MemoOnContractCallError);
        expect(err).toBeInstanceOf(InvalidInputError);
        expect((err as MemoOnContractCallError).code).toBe('INVALID_INPUT');
        expect((err as MemoOnContractCallError).name).toBe('MemoOnContractCallError');
        expect((err as MemoOnContractCallError).network).toBe(NETWORK);
        expect((err as MemoOnContractCallError).landed).toBe('no');
        expect((err as MemoOnContractCallError).toJSON().issues).toEqual(['memo (contract_call)']);
      }
    }
  });

  it('refuses a memo passed to the builder at all, in the types and at run time', () => {
    const typed: ContractCallTransactionInput = {
      ...input(extendTtl(100)),
      // @ts-expect-error The builder input has no memo field.
      memo: Memo.text('x'),
    };
    expect(thrown(() => buildContractCallTransaction(typed))).toBeInstanceOf(InvalidInputError);
    expect(
      thrown(() =>
        buildContractCallTransaction({ ...input(restoreArchived()), memo: 'x' } as never),
      ),
    ).toBeInstanceOf(InvalidInputError);
  });

  it('checks a legacy v0 envelope too', () => {
    const v1 = handBuilt(invoke(), Memo.text('x')).toEnvelope().v1().tx();
    const v0 = new xdr.TransactionV0({
      sourceAccountEd25519: v1.sourceAccount().ed25519(),
      fee: v1.fee(),
      seqNum: v1.seqNum(),
      timeBounds: null,
      memo: v1.memo(),
      operations: v1.operations(),
      ext: new xdr.TransactionV0Ext(0),
    });
    const text = xdr.TransactionEnvelope.envelopeTypeTxV0(
      new xdr.TransactionV0Envelope({ tx: v0, signatures: [] }),
    ).toXDR('base64');
    expect(
      thrown(() => {
        assertNoMemoOnContractCall(text, NETWORK);
      }),
    ).toBeInstanceOf(MemoOnContractCallError);
  });

  it('allows a memo on a transaction that calls no contract', () => {
    const payment = Operation.payment({
      destination: SPONSOR,
      asset: Asset.native(),
      amount: '1',
    });
    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100',
      networkPassphrase: PASSPHRASE,
      memo: Memo.text('rent'),
      timebounds: { minTime: 0, maxTime: 1_900_000_000 },
    })
      .addOperation(payment)
      .build();
    expect(() => {
      assertNoMemoOnContractCall(tx.toEnvelope().toXDR('base64'), NETWORK);
    }).not.toThrow();
  });

  it('refuses text that is not one canonical envelope, and an unknown network', () => {
    const good = handBuilt(invoke(), Memo.none()).toEnvelope().toXDR('base64');
    for (const bad of ['', 'not base64!', 'AAAA', `${good}AAAA`, 'x'.repeat(400_000), 7]) {
      const err = thrown(() => {
        assertNoMemoOnContractCall(bad as string, NETWORK);
      });
      expect(err).toBeInstanceOf(InvalidInputError);
      expect(err).not.toBeInstanceOf(MemoOnContractCallError);
    }
    expect(
      thrown(() => {
        assertNoMemoOnContractCall(good, 'stellar:mainnet' as never);
      }),
    ).toBeInstanceOf(InvalidInputError);
  });

  it('fee bump of an inner transaction with a memo is rejected', () => {
    for (const [, memo] of MEMOS) {
      const inner = handBuilt(invoke(), memo).toEnvelope().toXDR('base64');
      expect(
        thrown(() => wrapInFeeBump({ network: NETWORK, inner, feeSource: SPONSOR, fee: 200n })),
      ).toBeInstanceOf(MemoOnContractCallError);
      // The same wrap done by hand, past the adapter's own wrapper.
      const bumped = TransactionBuilder.buildFeeBumpTransaction(
        SPONSOR,
        '200',
        handBuilt(invoke(), memo),
        PASSPHRASE,
      );
      expect(
        thrown(() => {
          assertNoMemoOnContractCall(bumped.toEnvelope().toXDR('base64'), NETWORK);
        }),
      ).toBeInstanceOf(MemoOnContractCallError);
    }
  });

  it('wraps a clean inner transaction in a fee bump with no memo', () => {
    const inner = buildContractCallTransaction(input(mandateCall(MANDATE, 'execute', [])));
    const envelope = envelopeOf(
      wrapInFeeBump({ network: NETWORK, inner, feeSource: SPONSOR, fee: 200n }),
    );
    expect(envelope.switch().name).toBe('envelopeTypeTxFeeBump');
    expect(memoName(envelope)).toBe('memoNone');
    const outer = envelope.feeBump().tx();
    expect(StrKey.encodeEd25519PublicKey(outer.feeSource().ed25519())).toBe(SPONSOR);
    expect(outer.innerTx().v1().toXDR('base64')).toBe(envelopeOf(inner).v1().toXDR('base64'));
  });

  it('refuses to fee bump anything but a plain transaction, or with bad inputs', () => {
    const inner = buildContractCallTransaction(input(restoreArchived()));
    const bumped = wrapInFeeBump({ network: NETWORK, inner, feeSource: SPONSOR, fee: 200n });
    const bad: unknown[] = [
      { network: NETWORK, inner: bumped, feeSource: SPONSOR, fee: 200n },
      { network: NETWORK, inner, feeSource: MANDATE, fee: 200n },
      { network: NETWORK, inner, feeSource: SPONSOR, fee: 0n },
      { network: NETWORK, inner, feeSource: SPONSOR, fee: 200 },
      { network: 'stellar:mainnet', inner, feeSource: SPONSOR, fee: 200n },
      { network: NETWORK, inner, feeSource: SPONSOR, fee: 200n, memo: 'x' },
    ];
    for (const value of bad) {
      expect(thrown(() => wrapInFeeBump(value as never))).toBeInstanceOf(InvalidInputError);
    }
  });

  it('relayer submission with a memo is rejected', async () => {
    const send = vi.fn<EnvelopeTransport<string>['send']>(() => Promise.resolve('sent'));
    for (const [, memo] of MEMOS) {
      const inner = handBuilt(invoke(), memo).toEnvelope().toXDR('base64');
      expect(thrown(() => relayerRequest(inner, NETWORK))).toBeInstanceOf(MemoOnContractCallError);
      await expect(
        submitEnvelope({ send }, inner, { network: NETWORK, timeoutMs: 1_000 }),
      ).rejects.toBeInstanceOf(MemoOnContractCallError);
    }
    expect(send).not.toHaveBeenCalled();
    const clean = buildContractCallTransaction(input(mandateCall(MANDATE, 'approve', [])));
    expect(relayerRequest(clean, NETWORK)).toEqual({ network: NETWORK, xdr: clean });
    expect(Object.isFrozen(relayerRequest(clean, NETWORK))).toBe(true);
  });

  it('a relayer takes only the inner transaction, which it wraps itself', () => {
    const inner = buildContractCallTransaction(input(mandateCall(MANDATE, 'approve', [])));
    const bumped = wrapInFeeBump({ network: NETWORK, inner, feeSource: SPONSOR, fee: 200n });
    expect(thrown(() => relayerRequest(bumped, NETWORK))).toBeInstanceOf(InvalidInputError);
  });

  it('submit rejects a hand built transaction with a memo', async () => {
    const send = vi.fn<EnvelopeTransport<string>['send']>(() => Promise.resolve('sent'));
    for (const [, memo] of MEMOS) {
      for (const [, operation] of CONTRACT_OPERATIONS) {
        const tx = handBuilt(operation(), memo);
        const plain = tx.toEnvelope().toXDR('base64');
        const bumped = TransactionBuilder.buildFeeBumpTransaction(SPONSOR, '200', tx, PASSPHRASE)
          .toEnvelope()
          .toXDR('base64');
        for (const text of [plain, bumped]) {
          await expect(
            submitEnvelope({ send }, text, { network: NETWORK, timeoutMs: 1_000 }),
          ).rejects.toBeInstanceOf(MemoOnContractCallError);
        }
      }
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('submits a clean envelope exactly as given and returns what the transport answers', async () => {
    const send = vi.fn<EnvelopeTransport<string>['send']>(() => Promise.resolve('hash'));
    const inner = buildContractCallTransaction(input(mandateCall(MANDATE, 'sweep', [])));
    const bumped = wrapInFeeBump({ network: NETWORK, inner, feeSource: SPONSOR, fee: 200n });
    await expect(
      submitEnvelope({ send }, bumped, { network: NETWORK, timeoutMs: 1_000 }),
    ).resolves.toBe('hash');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(bumped);
    expect(send.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('times out a transport that never answers, as landed unknown', async () => {
    const inner = buildContractCallTransaction(input(mandateCall(MANDATE, 'pause', [])));
    const err: unknown = await submitEnvelope(
      { send: () => new Promise<never>(() => undefined) },
      inner,
      { network: NETWORK, timeoutMs: 20 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect((err as RpcTimeoutError).landed).toBe('unknown');
    expect((err as RpcTimeoutError).network).toBe(NETWORK);
  });

  it('keeps an adapter error from the transport and reads any other failure as maybe landed', async () => {
    const inner = buildContractCallTransaction(input(mandateCall(MANDATE, 'revoke', [])));
    const options = { network: NETWORK, timeoutMs: 1_000 } as const;
    const rejected = new SubmissionRejectedError({ network: NETWORK });
    await expect(
      submitEnvelope({ send: () => Promise.reject(rejected) }, inner, options),
    ).rejects.toBe(rejected);
    const err: unknown = await submitEnvelope(
      { send: () => Promise.reject(new TypeError('fetch failed: key=secret')) },
      inner,
      options,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionUnknownError);
    expect((err as SubmissionUnknownError).landed).toBe('unknown');
    expect(String((err as SubmissionUnknownError).cause)).not.toContain('secret');
  });

  it('refuses a timeout it cannot honour', async () => {
    const inner = buildContractCallTransaction(input(restoreArchived()));
    const send = vi.fn<EnvelopeTransport<string>['send']>(() => Promise.resolve('x'));
    for (const timeoutMs of [0, -1, 1.5, 600_001, Number.NaN]) {
      await expect(
        submitEnvelope({ send }, inner, { network: NETWORK, timeoutMs }),
      ).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses builder input it cannot build from', () => {
    const base = input(mandateCall(MANDATE, 'execute', []));
    const bad: unknown[] = [
      { ...base, network: 'stellar:mainnet' },
      { ...base, source: MANDATE },
      { ...base, source: 'G123' },
      { ...base, sequence: -1n },
      { ...base, sequence: 2n ** 63n - 1n },
      { ...base, inclusionFee: 99n },
      { ...base, inclusionFee: 2n ** 32n },
      { ...base, timeBounds: { minTime: 0n, maxTime: 0n } },
      { ...base, timeBounds: { minTime: 10n, maxTime: 5n } },
      { ...base, sorobanData: 'not xdr' },
      { ...base, sorobanData: 'AAAA' },
      { ...base, call: { kind: 'invoke', contract: SOURCE, method: 'execute', args: [] } },
      { ...base, call: { kind: 'invoke', contract: MANDATE, method: 'no spaces', args: [] } },
      { ...base, call: { kind: 'invoke', contract: MANDATE, method: 'execute', args: ['x'] } },
      { ...base, call: { kind: 'extend_ttl', extendTo: 0 } },
      { ...base, call: { kind: 'restore', memo: 'x' } },
      { ...base, call: { kind: 'upload' } },
      null,
    ];
    for (const value of bad) {
      expect(thrown(() => buildContractCallTransaction(value as never))).toBeInstanceOf(
        InvalidInputError,
      );
    }
  });

  it('refuses a fee the transaction cannot carry once the resource fee is added', () => {
    const data = new SorobanDataBuilder()
      .setResourceFee(2 ** 32 - 100)
      .build()
      .toXDR('base64');
    expect(
      thrown(() =>
        buildContractCallTransaction({ ...input(restoreArchived()), sorobanData: data }),
      ),
    ).toBeInstanceOf(InvalidInputError);
  });

  it('refuses a second spelling of the same envelope', () => {
    // Base64 that leaves spare bits in its last character decodes to the
    // same bytes whatever those bits are. Only the canonical text passes,
    // so what was checked is exactly what is sent.
    const padded = [0, 1, 2]
      .map((count) =>
        buildContractCallTransaction(
          input(
            mandateCall(
              MANDATE,
              'execute',
              Array.from({ length: count }, () => xdr.ScVal.scvVoid()),
            ),
          ),
        ),
      )
      .find((text) => text.endsWith('='));
    expect(padded).toBeDefined();
    const text = padded ?? '';
    const at = text.search(/=+$/) - 1;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const spare = alphabet.charAt(alphabet.indexOf(text.charAt(at)) + 1);
    const respelled = `${text.slice(0, at)}${spare}${text.slice(at + 1)}`;
    expect(Buffer.from(respelled, 'base64')).toEqual(Buffer.from(text, 'base64'));
    const err = thrown(() => {
      assertNoMemoOnContractCall(respelled, NETWORK);
    });
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as InvalidInputError).issues).toEqual(['xdr (malformed)']);
  });

  it('builds the relayer form: a channel account sends the caller authorization, with no memo', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(MANDATE).toScAddress(),
            functionName: 'approve',
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
    const call: ContractCall = {
      kind: 'invoke',
      contract: MANDATE,
      method: 'approve',
      args: [],
      auth: [entry],
    };
    const text = buildContractCallTransaction({ ...input(call), source: SPONSOR });
    const envelope = envelopeOf(text);
    expect(memoName(envelope)).toBe('memoNone');
    const op = envelope.v1().tx().operations()[0]?.body().invokeHostFunctionOp();
    expect(op?.auth().map((a) => a.toXDR('base64'))).toEqual([entry.toXDR('base64')]);
    expect(relayerRequest(text, NETWORK).xdr).toBe(text);
    expect(
      thrown(() =>
        buildContractCallTransaction(
          input({ ...mandateCall(MANDATE, 'approve', []), auth: ['x'] } as never),
        ),
      ),
    ).toBeInstanceOf(InvalidInputError);
  });

  it('refuses a funding transfer to or from something that is not an address', () => {
    for (const [from, to] of [
      ['G123', MANDATE],
      [SOURCE, 'not an address'],
    ]) {
      expect(
        thrown(() => fundingTransfer({ token: TOKEN, from: from ?? '', to: to ?? '', amount: 1n })),
      ).toBeInstanceOf(InvalidInputError);
    }
  });

  it('refuses a negative or oversized funding amount', () => {
    for (const amount of [-1n, 2n ** 127n]) {
      expect(
        thrown(() => fundingTransfer({ token: TOKEN, from: SOURCE, to: MANDATE, amount })),
      ).toBeInstanceOf(InvalidInputError);
    }
  });

  it('exports MemoOnContractCallError from the package root', () => {
    expect((index as Record<string, unknown>)['MemoOnContractCallError']).toBe(
      MemoOnContractCallError,
    );
    const bare = new MemoOnContractCallError();
    expect(bare.network).toBeNull();
    expect(bare.retryable).toBe(false);
    expect(bare.toJSON()).toEqual({
      code: 'INVALID_INPUT',
      network: null,
      retryable: false,
      landed: 'no',
      retryAfterMs: null,
      waitFor: 'none',
      issues: ['memo (contract_call)'],
    });
  });
});
