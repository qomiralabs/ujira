// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import {
  Address,
  Keypair,
  Memo,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import {
  InvalidInputError,
  MandateRuleError,
  MemoOnContractCallError,
  RpcRateLimitedError,
  RpcTimeoutError,
  SignedPayloadMismatchError,
  SigningRequestExpiredError,
  SponsorDeniedError,
  SubmissionRejectedError,
  SubmissionUnknownError,
} from '../errors.js';
import type { ChainAddress, MandateAction, SigningRequest } from '../types.js';
import { reservationIdOf } from '../sponsorship/policy.js';
import { NETWORK, OPTS, addAccount, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { failedFeeBumpResult, failedResult } from './test-results.js';
import { invoked } from './test-rpc.js';
import { PASSPHRASES, accountKey } from './tx.js';

const at = (value: string): ChainAddress => ({ network: NETWORK, value });
const passphrase = PASSPHRASES[NETWORK];

async function prepare(t: TestSetup, action: MandateAction, signer = t.principal.publicKey()) {
  return t.adapter.prepareMandateAction(
    {
      scope: t.scope,
      mandate: t.mandate,
      action,
      signer: { kind: 'external', network: NETWORK, role: 'principal', address: at(signer) },
    },
    OPTS,
  );
}

function sign(request: SigningRequest, key: Keypair): string {
  return signAll(request, [key]);
}

function signAll(request: SigningRequest, keys: readonly Keypair[]): string {
  if (request.kind !== 'stellar_transaction') throw new Error('expected a transaction');
  const tx = TransactionBuilder.fromXdr(request.xdr, passphrase);
  for (const key of keys) tx.sign(key);
  return tx.toXdr();
}

function submit(t: TestSetup, requestId: string, signed: string) {
  return t.adapter.submitSigned({ scope: t.scope, requestId, signed, correlationId: 'c' }, OPTS);
}

// Building and parsing XDR is slow on a loaded machine, so each test gets
// more than the default five seconds.
describe('submitSigned for an account signer', { timeout: 30_000 }, () => {
  it('wraps the signed transaction in a sponsored fee bump, records it, then sends it', async () => {
    const t = setup();
    const request = await prepare(t, { op: 'pause' });
    const signed = sign(request, t.principal);
    const ref = await submit(t, request.requestId, signed);
    expect(ref).toMatchObject({ network: NETWORK, finality: 'none' });

    const [sent] = t.rpc.sent;
    const bump = TransactionBuilder.fromXdr(sent ?? '', passphrase) as FeeBumpTransaction;
    expect(bump.feeSource).toBe(t.sponsor.publicKey());
    expect(bump.innerTransaction.toXdr()).toBe(signed);
    expect(Buffer.from(bump.hash()).toString('hex')).toBe(ref.txHash);

    const record = t.store.submissions.get(`${NETWORK}:${ref.txHash}`);
    expect(record).toMatchObject({
      op: 'pause',
      mandate: t.mandate.address.value,
      signerAddress: t.principal.publicKey(),
      sequenceOrNonce: 101n,
      state: 'broadcast',
      correlationId: 'c',
    });
    // Reserved under the key the signer looks up: the network and the inner hash.
    expect(t.sponsorship.calls).toEqual([
      { kind: 'reserve', id: reservationIdOf(NETWORK, bump.innerTransaction.hash()) },
    ]);
  });

  it('changed operation after signing is rejected', async () => {
    const t = setup();
    const pause = await prepare(t, { op: 'pause' });
    const resume = await prepare(t, { op: 'resume' });
    // Same account and sequence, a different operation, properly signed.
    await expect(submit(t, pause.requestId, sign(resume, t.principal))).rejects.toBeInstanceOf(
      SignedPayloadMismatchError,
    );
    // A copy of the request with only its fee raised fails the same way.
    if (pause.kind !== 'stellar_transaction') throw new Error('expected a transaction');
    const original = TransactionBuilder.fromXdr(pause.xdr, passphrase) as Transaction;
    const edited = TransactionBuilder.cloneFrom(original, {
      fee: String(Number(original.fee) + 1),
      networkPassphrase: passphrase,
    }).build();
    edited.sign(t.principal);
    await expect(submit(t, pause.requestId, edited.toXdr())).rejects.toBeInstanceOf(
      SignedPayloadMismatchError,
    );
    expect(t.rpc.sent).toHaveLength(0);
    expect(t.sponsorship.calls).toHaveLength(0);
  });

  it('refuses an unsigned, a wrongly signed, a fee bumped and a malformed payload', async () => {
    const t = setup();
    const request = await prepare(t, { op: 'pause' });
    if (request.kind !== 'stellar_transaction') throw new Error('expected a transaction');
    await expect(submit(t, request.requestId, request.xdr)).rejects.toBeInstanceOf(
      SignedPayloadMismatchError,
    );
    await expect(
      submit(t, request.requestId, sign(request, Keypair.random())),
    ).rejects.toBeInstanceOf(SignedPayloadMismatchError);
    const inner = TransactionBuilder.fromXdr(sign(request, t.principal), passphrase) as Transaction;
    const bumped = TransactionBuilder.buildFeeBumpTransaction(
      t.principal,
      '200',
      inner,
      passphrase,
    );
    await expect(submit(t, request.requestId, bumped.toXdr())).rejects.toBeInstanceOf(
      SignedPayloadMismatchError,
    );
    await expect(submit(t, request.requestId, 'not xdr')).rejects.toBeInstanceOf(InvalidInputError);
    // None of these used the request up.
    await submit(t, request.requestId, sign(request, t.principal));
  });

  it('takes a multisig principal with its master key off, signed by enough of its signers', async () => {
    const t = setup();
    const [a, b, c] = [Keypair.random(), Keypair.random(), Keypair.random()];
    // Two of three: the network authorizes the call at medium, and the
    // envelope at low.
    addAccount(t.rpc, t.principal.publicKey(), 100n, undefined, {
      masterWeight: 0,
      low: 1,
      medium: 2,
      high: 2,
      signers: [a, b, c].map((key) => ({ key: key.publicKey(), weight: 1 })),
    });
    const request = await prepare(t, { op: 'pause' });
    const refused = [
      [t.principal], // the master key, at weight 0
      [a], // one signature short
      [a, Keypair.random()], // a stranger makes up the weight
      [a, a], // one signer counted twice
      [t.principal, a], // the master key adds nothing
    ];
    for (const keys of refused) {
      await expect(submit(t, request.requestId, signAll(request, keys))).rejects.toBeInstanceOf(
        SignedPayloadMismatchError,
      );
    }
    expect(t.rpc.sent).toHaveLength(0);
    const signed = signAll(request, [a, c]);
    const ref = await submit(t, request.requestId, signed);
    const [sent] = t.rpc.sent;
    const bump = TransactionBuilder.fromXdr(sent ?? '', passphrase) as FeeBumpTransaction;
    expect(bump.innerTransaction.toXdr()).toBe(signed);
    expect(Buffer.from(bump.hash()).toString('hex')).toBe(ref.txHash);
  });

  it('counts weights against the higher of low and medium, read when the signature arrives', async () => {
    const t = setup();
    const [a, b] = [Keypair.random(), Keypair.random()];
    const request = await prepare(t, { op: 'pause' });
    // Changed after the request was made: what counts is the account now.
    const signers = [a, b].map((key) => ({ key: key.publicKey(), weight: 1 }));
    addAccount(t.rpc, t.principal.publicKey(), 100n, undefined, {
      masterWeight: 1,
      low: 2,
      medium: 1,
      high: 3,
      signers,
    });
    // Medium is met, but the envelope needs low as well.
    await expect(submit(t, request.requestId, sign(request, a))).rejects.toBeInstanceOf(
      SignedPayloadMismatchError,
    );
    // An account that is gone cannot authorize anything.
    t.rpc.entries.delete(accountKey(t.principal.publicKey()));
    await expect(
      submit(t, request.requestId, signAll(request, [t.principal, a])),
    ).rejects.toBeInstanceOf(SignedPayloadMismatchError);
    expect(t.rpc.sent).toHaveLength(0);
    addAccount(t.rpc, t.principal.publicKey(), 100n, undefined, {
      masterWeight: 1,
      low: 2,
      medium: 1,
      high: 3,
      signers,
    });
    await submit(t, request.requestId, signAll(request, [t.principal, a]));
    expect(t.rpc.sent).toHaveLength(1);
  });

  it('refuses an unknown request, another tenant and an expired request', async () => {
    const t = setup();
    const request = await prepare(t, { op: 'pause' });
    const signed = sign(request, t.principal);
    await expect(submit(t, 'req-none', signed)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      t.adapter.submitSigned(
        {
          scope: { ...t.scope, projectId: '00000000-0000-4000-8000-000000000009' as never },
          requestId: request.requestId,
          signed,
          correlationId: 'c',
        },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    t.clock.now += 601n;
    await expect(submit(t, request.requestId, signed)).rejects.toBeInstanceOf(
      SigningRequestExpiredError,
    );
  });

  it('answers the same signed payload again with the same submission, and refuses any other', async () => {
    const t = setup();
    const request = await prepare(t, { op: 'pause' });
    const signed = sign(request, t.principal);
    const first = await submit(t, request.requestId, signed);
    t.clock.now += 10_000n;
    const again = await submit(t, request.requestId, signed);
    expect(again).toEqual({ ...first, finality: 'final' });
    t.rpc.txs.set(first.txHash, { status: 'NOT_FOUND' });
    expect((await submit(t, request.requestId, signed)).finality).toBe('none');
    expect(t.rpc.sent).toHaveLength(1);
    await expect(
      submit(t, request.requestId, sign(request, Keypair.random())),
    ).rejects.toBeInstanceOf(SignedPayloadMismatchError);

    // Claimed but never built, as after a crash: the outcome is unknown.
    const other = await prepare(t, { op: 'resume' });
    const otherSigned = sign(other, t.principal);
    await t.requests.claim(t.scope, other.requestId, otherSigned);
    await expect(submit(t, other.requestId, otherSigned)).rejects.toBeInstanceOf(
      SubmissionUnknownError,
    );
  });

  it('gives the reservation back when the node refuses, and keeps it when the answer is lost', async () => {
    const rejected = setup();
    rejected.rpc.sendResult = () => ({ status: 'ERROR', hash: 'x', errorResultXdr: 'AAAA' });
    const r1 = await prepare(rejected, { op: 'pause' });
    await expect(
      submit(rejected, r1.requestId, sign(r1, rejected.principal)),
    ).rejects.toBeInstanceOf(SubmissionRejectedError);
    expect([...rejected.store.submissions.values()][0]).toMatchObject({
      state: 'failed',
      errorCode: 'SUBMISSION_REJECTED',
    });
    expect(rejected.sponsorship.calls.map((c) => c.kind)).toEqual(['reserve', 'release']);

    // Busy is not a refusal: the identical envelope goes again, and a send that
    // never got through stays open with its reservation held.
    const busy = setup();
    busy.rpc.sendResult = () => ({ status: 'TRY_AGAIN_LATER', hash: 'x' });
    const r2 = await prepare(busy, { op: 'pause' });
    await expect(submit(busy, r2.requestId, sign(r2, busy.principal))).rejects.toBeInstanceOf(
      SubmissionUnknownError,
    );
    expect(busy.rpc.sent.length).toBeGreaterThan(1);
    expect(new Set(busy.rpc.sent).size).toBe(1);
    expect([...busy.store.submissions.values()][0]).toMatchObject({ state: 'broadcast' });
    expect(busy.sponsorship.calls.map((c) => c.kind)).toEqual(['reserve']);

    const lost = setup();
    lost.rpc.sendResult = () => {
      throw new RpcTimeoutError({ network: NETWORK });
    };
    const r3 = await prepare(lost, { op: 'pause' });
    await expect(submit(lost, r3.requestId, sign(r3, lost.principal))).rejects.toBeInstanceOf(
      RpcTimeoutError,
    );
    expect([...lost.store.submissions.values()][0]).toMatchObject({ state: 'unknown' });
    expect(lost.sponsorship.calls.map((c) => c.kind)).toEqual(['reserve']);
  });

  it('goes through the one builder and submit path', async () => {
    const t = setup();
    const request = await prepare(t, { op: 'pause' });
    await submit(t, request.requestId, sign(request, t.principal));
    const bump = TransactionBuilder.fromXdr(t.rpc.sent[0] ?? '', passphrase) as FeeBumpTransaction;
    expect(bump.innerTransaction.memo.type).toBe('none');
    // The sponsor pays the resource fee and an inclusion fee for each of the
    // inner operation and the bump, and the fee was reserved as that much.
    expect(BigInt(bump.fee)).toBe(t.rpc.resourceFee + 200n);
    expect(request.summary.estimatedFee?.amount).toBe(t.rpc.resourceFee + 200n);
  });

  it('refuses a stored request that carries a memo before the sponsor signs anything', async () => {
    const t = setup();
    const built = await prepare(t, { op: 'pause' });
    if (built.kind !== 'stellar_transaction') throw new Error('expected a transaction');
    const original = TransactionBuilder.fromXdr(built.xdr, passphrase) as Transaction;
    const withMemo = TransactionBuilder.cloneFrom(original, {
      fee: '100',
      networkPassphrase: passphrase,
      memo: Memo.text('nope'),
    }).build();
    const stored = await t.requests.load(t.scope, built.requestId);
    if (stored === null) throw new Error('expected a stored request');
    await t.requests.save({ ...stored.request, requestId: 'memo', payload: withMemo.toXdr() });
    withMemo.sign(t.principal);
    await expect(submit(t, 'memo', withMemo.toXdr())).rejects.toBeInstanceOf(
      MemoOnContractCallError,
    );
    expect(t.rpc.sent).toHaveLength(0);
    expect(t.store.submissions.size).toBe(0);
    expect(t.sponsorship.calls.map((c) => c.kind)).toEqual(['reserve', 'release']);
  });

  it('treats a send with no answer by the deadline as unknown and keeps the reservation', async () => {
    const t = setup({ submitTimeoutMs: 1 });
    t.rpc.sendTransaction = () => new Promise(() => undefined);
    const request = await prepare(t, { op: 'pause' });
    const refused = submit(t, request.requestId, sign(request, t.principal));
    await expect(refused).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(refused).rejects.toMatchObject({ landed: 'unknown' });
    expect([...t.store.submissions.values()][0]).toMatchObject({ state: 'unknown' });
    expect(t.sponsorship.calls.map((c) => c.kind)).toEqual(['reserve']);
  });

  it('records a send the transport refused with nothing sent as failed, and passes the caller signal', async () => {
    const t = setup();
    t.rpc.sendResult = () => {
      throw new RpcRateLimitedError({ network: NETWORK });
    };
    const request = await prepare(t, { op: 'pause' });
    const caller = new AbortController();
    await expect(
      t.adapter.submitSigned(
        {
          scope: t.scope,
          requestId: request.requestId,
          signed: sign(request, t.principal),
          correlationId: 'c',
        },
        { correlationId: 'c', signal: caller.signal },
      ),
    ).rejects.toBeInstanceOf(RpcRateLimitedError);
    expect([...t.store.submissions.values()][0]).toMatchObject({
      state: 'failed',
      errorCode: 'RPC_RATE_LIMITED',
    });
    expect(t.sponsorship.calls.map((c) => c.kind)).toEqual(['reserve', 'release']);
    caller.abort();
    expect(t.rpc.sendOptions[0]?.signal?.aborted).toBe(true);
  });

  it('stops before signing anything when sponsorship is denied', async () => {
    const t = setup({ deny: true });
    const request = await prepare(t, { op: 'pause' });
    await expect(submit(t, request.requestId, sign(request, t.principal))).rejects.toThrow(
      'denied',
    );
    expect(t.rpc.sent).toHaveLength(0);
  });
});

describe('submitSigned for a smart wallet', { timeout: 30_000 }, () => {
  const WALLET = Address.contract(Buffer.alloc(32, 3)).toString();

  function walletSetup(): TestSetup {
    const t = setup();
    t.rpc.options.principal = WALLET;
    return t;
  }

  function withSignature(entryXdr: string, signature: xdr.ScVal): string {
    const entry = xdr.SorobanAuthorizationEntry.fromXdr(entryXdr, 'base64');
    const c = entry.credentials;
    if (c.type !== 'sorobanCredentialsAddress') throw new Error('expected address credentials');
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: c.address.address,
          nonce: c.address.nonce,
          signatureExpirationLedger: c.address.signatureExpirationLedger,
          signature,
        }),
      ),
      rootInvocation: entry.rootInvocation,
    }).toXdr('base64');
  }

  it('hands out the entry to sign and sends it from a leased channel account', async () => {
    const t = walletSetup();
    const request = await prepare(t, { op: 'resume' }, WALLET);
    if (request.kind !== 'stellar_auth_entry') throw new Error('expected an auth entry');
    expect(request.expirationLedger).toBe(t.rpc.latest.sequence + 120);
    const signed = withSignature(request.entryXdr, xdr.ScVal.scvBytes(Buffer.alloc(64, 5)));
    const ref = await submit(t, request.requestId, signed);

    const sent = TransactionBuilder.fromXdr(t.rpc.sent[0] ?? '', passphrase) as Transaction;
    expect(sent.source).toBe(t.channel.publicKey());
    expect(sent.sequence).toBe('901');
    expect(invoked(sent)).toMatchObject({ contract: t.mandate.address.value, fn: 'resume' });
    const op = sent.toEnvelope();
    const body = op.type === 'envelopeTypeTx' ? op.v1.tx.operations[0]?.body : undefined;
    expect(
      body?.type === 'invokeHostFunction' && body.invokeHostFunctionOp.auth[0]?.toXdr('base64'),
    ).toBe(signed);
    expect(t.store.submissions.get(`${NETWORK}:${ref.txHash}`)).toMatchObject({
      signerAddress: t.channel.publicKey(),
      sequenceOrNonce: 901n,
      state: 'broadcast',
    });
    expect(t.store.releases).toEqual([
      { leaseId: expect.any(String) as string, sequenceOrNonce: 902n },
    ]);
  });

  it('refuses an entry changed in anything but its signature, or left unsigned', async () => {
    const t = walletSetup();
    const request = await prepare(t, { op: 'resume' }, WALLET);
    if (request.kind !== 'stellar_auth_entry') throw new Error('expected an auth entry');
    const entry = xdr.SorobanAuthorizationEntry.fromXdr(request.entryXdr, 'base64');
    const c = entry.credentials;
    if (c.type !== 'sorobanCredentialsAddress') throw new Error('expected address credentials');
    const longer = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: c.address.address,
          nonce: c.address.nonce,
          signatureExpirationLedger: c.address.signatureExpirationLedger + 1000,
          signature: xdr.ScVal.scvBytes(Buffer.alloc(64, 5)),
        }),
      ),
      rootInvocation: entry.rootInvocation,
    }).toXdr('base64');
    await expect(submit(t, request.requestId, longer)).rejects.toBeInstanceOf(
      SignedPayloadMismatchError,
    );
    await expect(submit(t, request.requestId, request.entryXdr)).rejects.toBeInstanceOf(
      SignedPayloadMismatchError,
    );
    const source = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: entry.rootInvocation,
    }).toXdr('base64');
    await expect(submit(t, request.requestId, source)).rejects.toBeInstanceOf(
      SignedPayloadMismatchError,
    );
    await expect(submit(t, request.requestId, '@@')).rejects.toBeInstanceOf(InvalidInputError);
    expect(t.rpc.sent).toHaveLength(0);
  });

  it('refuses at prepare a wallet call that needs no entry, or one for someone else', async () => {
    const none = walletSetup();
    none.rpc.onSimulate = (tx) => none.rpc.success(tx, xdr.ScVal.scvVoid(), []);
    await expect(prepare(none, { op: 'resume' }, WALLET)).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );

    const other = walletSetup();
    other.rpc.options.principal = Address.contract(Buffer.alloc(32, 4)).toString();
    await expect(prepare(other, { op: 'resume' }, WALLET)).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );
  });

  it('releases the lease and the reservation when the channel transaction costs too much', async () => {
    const t = walletSetup();
    const request = await prepare(t, { op: 'resume' }, WALLET);
    if (request.kind !== 'stellar_auth_entry') throw new Error('expected an auth entry');
    t.rpc.resourceFee = 30_000_000n;
    const signed = withSignature(request.entryXdr, xdr.ScVal.scvBytes(Buffer.alloc(64, 5)));
    await expect(submit(t, request.requestId, signed)).rejects.toBeInstanceOf(SponsorDeniedError);
    expect(t.store.releases).toHaveLength(1);
    expect(t.sponsorship.calls.map((c) => c.kind)).toEqual(['reserve', 'release']);
  });
});

describe('re-simulating after a resource failure', { timeout: 30_000 }, () => {
  const pauseReq = (t: TestSetup) =>
    ({
      scope: t.scope,
      mandate: t.mandate,
      action: { op: 'pause' },
      signer: {
        kind: 'external',
        network: NETWORK,
        role: 'principal',
        address: at(t.principal.publicKey()),
      },
    }) as const;

  // A simulation that reports archived entries, so the adapter runs its own
  // restore transaction, which is sent from a channel account and waited for.
  function archivedOnce(t: TestSetup): void {
    const keys = [
      xdr.LedgerKey.contractCode(
        new xdr.LedgerKeyContractCode({ hash: new Uint8Array(32).fill(1) }),
      ),
    ];
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
  }

  it('ResourceLimitExceeded is re-simulated, never a MandateRuleError', async () => {
    const t = setup();
    archivedOnce(t);
    const failures = [failedResult('resource_limit'), failedResult('entry_archived')];
    const getTransaction = t.rpc.getTransaction.bind(t.rpc);
    t.rpc.getTransaction = (hash) => {
      const resultXdr = failures.shift();
      return resultXdr === undefined
        ? getTransaction(hash)
        : Promise.resolve({ status: 'FAILED', resultXdr });
    };
    const simulatedBefore = t.rpc.simulated.length;
    const request = await t.adapter.prepareMandateAction(pauseReq(t), OPTS);
    expect(request.kind).toBe('stellar_transaction');
    const sent = t.rpc.sent.map(
      (e) => (TransactionBuilder.fromXdr(e, passphrase) as Transaction).operations[0]?.type,
    );
    // Two tries refused for resources, then the third landed.
    expect(sent.filter((type) => type === 'restoreFootprint')).toHaveLength(3);
    // Every try was built from a simulation of its own, on the next sequence.
    const restores = t.rpc.sent
      .map((e) => TransactionBuilder.fromXdr(e, passphrase) as Transaction)
      .filter((tx) => tx.operations[0]?.type === 'restoreFootprint');
    const sequences = restores.map((tx) => BigInt(tx.sequence));
    expect(sequences).toEqual([901n, 902n, 903n]);
    expect(
      t.rpc.simulated
        .slice(simulatedBefore)
        .filter((tx) => tx.operations[0]?.type === 'restoreFootprint'),
    ).toHaveLength(3);
  });

  it('after the retries it fails as SUBMISSION_REJECTED with nothing landed', async () => {
    const t = setup();
    archivedOnce(t);
    t.rpc.getTransaction = () =>
      Promise.resolve({ status: 'FAILED', resultXdr: failedResult('resource_limit') });
    const failure: unknown = await t.adapter
      .prepareMandateAction(pauseReq(t), OPTS)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionRejectedError);
    expect(failure).not.toBeInstanceOf(MandateRuleError);
    expect(failure).toMatchObject({ code: 'SUBMISSION_REJECTED', landed: 'no' });
    // The first try and two retries.
    expect(t.rpc.sent).toHaveLength(3);
  });

  it('a failure that is not about resources is not retried', async () => {
    const t = setup();
    archivedOnce(t);
    t.rpc.getTransaction = () =>
      Promise.resolve({ status: 'FAILED', resultXdr: failedResult('trapped') });
    await expect(t.adapter.prepareMandateAction(pauseReq(t), OPTS)).rejects.toMatchObject({
      code: 'SUBMISSION_REJECTED',
      landed: 'yes',
    });
    expect(t.rpc.sent).toHaveLength(1);
  });

  it('reads a failed outcome again, and one the sweep already closed, without a store error', async () => {
    const t = setup();
    const req = pauseReq(t);
    const first = await t.adapter.prepareMandateAction(req, OPTS);
    const ref = await submit(t, first.requestId, sign(first, t.principal));
    t.rpc.txs.set(ref.txHash, { status: 'FAILED', resultXdr: failedResult('trapped') });
    const rejected = { code: 'SUBMISSION_REJECTED', landed: 'yes' };
    await expect(t.adapter.signedOutcome(req, first.requestId, OPTS)).rejects.toMatchObject(
      rejected,
    );
    await expect(t.adapter.signedOutcome(req, first.requestId, OPTS)).rejects.toMatchObject(
      rejected,
    );
  });

  it('a re-simulated principal action returns a new signing request with reason RESIMULATED', async () => {
    const t = setup();
    const req = pauseReq(t);
    const first = await t.adapter.prepareMandateAction(req, OPTS);
    expect(first).not.toHaveProperty('reason');
    const ref = await submit(t, first.requestId, sign(first, t.principal));
    t.rpc.txs.set(ref.txHash, {
      status: 'FAILED',
      resultXdr: failedFeeBumpResult('resource_limit'),
    });
    const sentBefore = t.rpc.sent.length;
    const simulatedBefore = t.rpc.simulated.length;

    const outcome = await t.adapter.signedOutcome(req, first.requestId, OPTS);
    if (outcome.status !== 'resimulated') throw new Error('expected a new signing request');
    expect(outcome.signingRequest).toMatchObject({ reason: 'RESIMULATED' });
    expect(outcome.signingRequest.requestId).not.toBe(first.requestId);
    // Handed back to sign, with a fresh simulation, and not submitted.
    expect(t.rpc.sent).toHaveLength(sentBefore);
    expect(t.rpc.simulated.length).toBeGreaterThan(simulatedBefore);
  });

  it('gives up on a principal action after the retries, never as a mandate rule', async () => {
    const t = setup();
    const req = pauseReq(t);
    let request = await t.adapter.prepareMandateAction(req, OPTS);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ref = await submit(t, request.requestId, sign(request, t.principal));
      t.rpc.txs.set(ref.txHash, {
        status: 'FAILED',
        resultXdr: failedFeeBumpResult('entry_archived'),
      });
      // A failed transaction still uses up its sequence on the chain.
      addAccount(t.rpc, t.principal.publicKey(), 101n + BigInt(attempt));
      const outcome = await t.adapter.signedOutcome(req, request.requestId, OPTS);
      if (outcome.status !== 'resimulated') throw new Error('expected a new signing request');
      request = outcome.signingRequest;
    }
    const ref = await submit(t, request.requestId, sign(request, t.principal));
    t.rpc.txs.set(ref.txHash, {
      status: 'FAILED',
      resultXdr: failedFeeBumpResult('entry_archived'),
    });
    const failure: unknown = await t.adapter
      .signedOutcome(req, request.requestId, OPTS)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionRejectedError);
    expect(failure).not.toBeInstanceOf(MandateRuleError);
    expect(failure).toMatchObject({ landed: 'no' });
  });
});
