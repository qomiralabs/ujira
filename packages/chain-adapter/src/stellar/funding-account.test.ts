// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The sponsored create_funding_account flow, against the real sponsorship
// policy and its in-memory ledger, so the limits here are the ones production
// enforces. The principal's key signs in the wallet; UJIRA's sponsor signs as a
// reserve sandwich and is never a signer on the account.

import { Keypair, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-base';
import {
  TransactionBuilder as SdkTransactionBuilder,
  xdr as sdkXdr,
} from '@stellar/stellar-sdk/base';
import type { Transaction as SdkTransaction } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import {
  InvalidInputError,
  SignedPayloadMismatchError,
  SignerDeniedError,
  SigningRequestExpiredError,
  SponsorDeniedError,
  SponsorUnfundedError,
  SubmissionRejectedError,
  SubmissionUnknownError,
} from '../errors.js';
import type { SignerProvider, SignPayload } from '../signer.js';
import { createSponsorshipPolicy } from '../sponsorship/policy.js';
import { createMemorySponsorshipLedger } from '../testing/sponsorship-ledger.js';
import type { AdapterPorts, SigningRequest, TenantScope, UnixSeconds } from '../types.js';

import type { FundingAccountFlow, FundingAccountStore } from '../funding-account.js';

import { createFundingAccountFlow } from './funding-account.js';
import type { ForwarderFault, ForwarderRecord } from './forwarder.js';
import { reconcileSubmission } from './lifecycle.js';
import { NETWORK, NOW, OPTS, addAccount, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { accountKey, PASSPHRASES } from './tx.js';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const VERIFIED = { businessVerified: true } as const;

function stranger(n: number): TenantScope {
  const tail = n.toString(16).padStart(4, '0');
  return {
    principalId: `0199a1f6-${tail}-7c21-9b8a-2d4e6f8a0b12`,
    projectId: `0199a1f6-${tail}-7a55-8e21-5b9c7d3e1f04`,
  } as TenantScope;
}

interface World {
  readonly t: TestSetup;
  readonly ports: AdapterPorts;
  readonly flow: FundingAccountFlow;
  readonly signed: SignPayload[];
  readonly flags: { readonly faults: readonly ForwarderFault[] }[];
  readonly ledger: ReturnType<typeof createMemorySponsorshipLedger>;
  readonly rows: Map<string, ForwarderRecord>;
  readonly checks: ForwarderRecord[];
}

function world(
  overrides: { readonly signer?: SignerProvider; readonly network?: 'stellar:pubnet' } = {},
): World {
  const t = setup();
  addAccount(t.rpc, t.sponsor.publicKey(), 500n);
  const ledger = createMemorySponsorshipLedger();
  const sponsorship = createSponsorshipPolicy({
    ledger,
    config: t.ports.config,
    clock: t.ports.clock,
    alerts: { lowBalance: () => undefined },
    sponsorBalance: () => Promise.resolve(100_000_000_000n),
  });
  const signed: SignPayload[] = [];
  const signer: SignerProvider = {
    ...t.ports.signer,
    sign: (ref, payload, opts) => {
      signed.push(payload);
      return (overrides.signer ?? t.ports.signer).sign(ref, payload, opts);
    },
  };
  const rows = new Map<string, ForwarderRecord>();
  const checks: ForwarderRecord[] = [];
  const accounts: FundingAccountStore = {
    forPrincipal: (scope, network) =>
      Promise.resolve(rows.get(`${scope.principalId}|${network}`) ?? null),
    record: (row) => {
      rows.set(`${row.principalId}|${row.network}`, row);
      return Promise.resolve();
    },
    recordCheck: (row) => {
      rows.set(`${row.principalId}|${row.network}`, row);
      checks.push(row);
      return Promise.resolve();
    },
  };
  const flags: { readonly faults: readonly ForwarderFault[] }[] = [];
  let id = 0;
  const ports: AdapterPorts = { ...t.ports, signer, sponsorship };
  const flow = createFundingAccountFlow({
    network: overrides.network ?? NETWORK,
    rpc: t.rpc,
    ports,
    requests: t.requests,
    accounts,
    flags: {
      flag: (event) => {
        flags.push(event);
      },
    },
    wait: { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() },
    submitTimeoutMs: 5_000,
    newRequestId: () => `funding-${String((id += 1))}`,
  });
  return { t, ports, flow, signed, flags, ledger, rows, checks };
}

function resultXdr(feeCharged: bigint): string {
  return new sdkXdr.TransactionResult({
    feeCharged,
    result: sdkXdr.TransactionResultResult.txSuccess([]),
    ext: sdkXdr.TransactionResultExt.v0(),
  }).toXdr('base64');
}

// What the reconciliation sweep does with the one submission on record.
async function reconciled(w: World): Promise<string> {
  const [record] = [...w.t.store.submissions.values()];
  if (record === undefined) throw new Error('expected a submission');
  const context = { network: NETWORK, rpc: w.t.rpc, ports: w.ports };
  return (await reconcileSubmission(context, record, OPTS)).state;
}

function fundingTotals(w: World) {
  return w.ledger.totals({
    network: NETWORK,
    since: 0n as UnixSeconds,
    intents: ['create_funding_account'],
  });
}

function transactionOf(request: SigningRequest): SdkTransaction {
  if (request.kind !== 'stellar_transaction') throw new Error('expected a transaction');
  return SdkTransactionBuilder.fromXdr(request.xdr, PASSPHRASES[NETWORK]) as SdkTransaction;
}

function signedBy(request: SigningRequest, wallet: Keypair): string {
  const tx = transactionOf(request);
  tx.addSignature(wallet.publicKey(), wallet.sign(Buffer.from(tx.hash())).toString('base64'));
  return tx.toXdr();
}

// Puts the account and trustline on the fake ledger, as the transaction would.
function land(
  w: World,
  wallet: Keypair,
  shape: {
    readonly signers?: readonly Keypair[];
    readonly sponsor?: Keypair | null;
    readonly noExt?: boolean;
  } = {},
): void {
  const sponsor =
    shape.sponsor === undefined ? Keypair.fromPublicKey(w.t.sponsor.publicKey()) : shape.sponsor;
  const id = (k: Keypair): xdr.PublicKey => xdr.PublicKey.publicKeyTypeEd25519(k.rawPublicKey());
  const ext =
    sponsor === null
      ? new xdr.LedgerEntryExt(0)
      : new xdr.LedgerEntryExt(
          1,
          new xdr.LedgerEntryExtensionV1({
            sponsoringId: id(sponsor),
            ext: new xdr.LedgerEntryExtensionV1Ext(0),
          }),
        );
  const account = xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: id(wallet),
      balance: xdr.Int64.fromString('0'),
      seqNum: xdr.Int64.fromString('1'),
      numSubEntries: 1,
      inflationDest: null,
      flags: 0,
      homeDomain: '',
      thresholds: Buffer.from([1, 0, 0, 0]),
      signers: (shape.signers ?? []).map(
        (key) =>
          new xdr.Signer({
            key: xdr.SignerKey.signerKeyTypeEd25519(key.rawPublicKey()),
            weight: 1,
          }),
      ),
      ext: new xdr.AccountEntryExt(0),
    }),
  );
  const line = xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: id(wallet),
      asset: xdr.TrustLineAsset.assetTypeCreditAlphanum4(
        new xdr.AlphaNum4({
          assetCode: Buffer.from('USDC'),
          issuer: id(Keypair.fromPublicKey(ISSUER)),
        }),
      ),
      balance: xdr.Int64.fromString('0'),
      limit: xdr.Int64.fromString('9223372036854775807'),
      flags: 1,
      ext: new xdr.TrustLineEntryExt(0),
    }),
  );
  const put = (key: string, data: xdr.LedgerEntryData): void => {
    w.t.rpc.entries.set(key, {
      key,
      xdr: data.toXDR('base64'),
      lastModifiedLedgerSeq: 5,
      ...(shape.noExt === true ? {} : { extXdr: ext.toXDR('base64') }),
    });
  };
  put(accountKey(wallet.publicKey()), account);
  put(
    xdr.LedgerKey.trustline(
      new xdr.LedgerKeyTrustLine({
        accountId: id(wallet),
        asset: xdr.TrustLineAsset.assetTypeCreditAlphanum4(
          new xdr.AlphaNum4({
            assetCode: Buffer.from('USDC'),
            issuer: id(Keypair.fromPublicKey(ISSUER)),
          }),
        ),
      }),
    ).toXDR('base64'),
    line,
  );
}

async function submitted(w: World, wallet: Keypair, scope: TenantScope = w.t.scope) {
  const request = await w.flow.prepare({ scope, publicKey: wallet.publicKey(), ...VERIFIED }, OPTS);
  const ref = await w.flow.submit(
    {
      scope,
      requestId: request.requestId,
      signed: signedBy(request, wallet),
      correlationId: 'test',
    },
    OPTS,
  );
  return { request, ref };
}

function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
}

describe('funding-account.test.ts', { timeout: 30_000 }, () => {
  it('begin, create, trust, end sponsoring', async () => {
    const w = world();
    const wallet = Keypair.random();
    const request = await w.flow.prepare(
      { scope: w.t.scope, publicKey: wallet.publicKey(), ...VERIFIED },
      OPTS,
    );
    expect(request).toMatchObject({
      kind: 'stellar_transaction',
      network: NETWORK,
      signer: { network: NETWORK, value: wallet.publicKey() },
      sponsored: true,
      summary: { action: 'create_funding_account', feePaidBy: 'ujira' },
      // The signer refuses a sandwich valid for more than five minutes.
      validUntil: NOW + 300n,
    });
    const tx = transactionOf(request);
    expect(tx.source).toBe(w.t.sponsor.publicKey());
    expect(tx.operations.map((op) => op.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
    expect(w.t.rpc.sent).toEqual([]);
  });

  it('signs as the sponsor once the wallet has, as a reserve sandwich, and sends', async () => {
    const w = world();
    const wallet = Keypair.random();
    const { ref } = await submitted(w, wallet);
    expect(w.signed.map((payload) => payload.kind)).toEqual(['stellar_reserve_sandwich']);
    expect(ref).toMatchObject({ network: NETWORK, finality: 'none' });
    const [sent] = w.t.rpc.sent;
    const tx = SdkTransactionBuilder.fromXdr(sent ?? '', PASSPHRASES[NETWORK]) as SdkTransaction;
    expect(tx.signatures).toHaveLength(2);
    const records = [...w.t.store.submissions.values()];
    expect(records.map((r) => [r.op, r.mandate, r.signerAddress, r.state])).toEqual([
      ['create_funding_account', null, w.t.sponsor.publicKey(), 'broadcast'],
    ]);
    // Reserved under the transaction's hash, which is how the signer finds it.
    const rows = await w.ledger.totals({
      network: NETWORK,
      since: 0n as UnixSeconds,
      intents: ['create_funding_account'],
    });
    expect(rows.count).toBe(1);
  });

  it('a second request for the same principal is SponsorDeniedError', async () => {
    const w = world();
    await submitted(w, Keypair.random());
    // A second key, before the first account is even confirmed: the policy
    // counts the reservation, and nothing is signed or sent.
    const second = Keypair.random();
    const request = await w.flow.prepare(
      { scope: w.t.scope, publicKey: second.publicKey(), ...VERIFIED },
      OPTS,
    );
    const sent = w.t.rpc.sent.length;
    const signed = w.signed.length;
    const err = await rejected(
      w.flow.submit(
        {
          scope: w.t.scope,
          requestId: request.requestId,
          signed: signedBy(request, second),
          correlationId: 'test',
        },
        OPTS,
      ),
    );
    expect(err).toBeInstanceOf(SponsorDeniedError);
    expect(w.t.rpc.sent).toHaveLength(sent);
    expect(w.signed).toHaveLength(signed);
    // In another project of the same principal the answer is the same.
    const sameprincipal = { ...w.t.scope, projectId: stranger(9).projectId };
    const again = Keypair.random();
    const other = await w.flow.prepare(
      { scope: sameprincipal, publicKey: again.publicKey(), ...VERIFIED },
      OPTS,
    );
    await expect(
      w.flow.submit(
        {
          scope: sameprincipal,
          requestId: other.requestId,
          signed: signedBy(other, again),
          correlationId: 'test',
        },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('refuses early once the principal has an account on record', async () => {
    const w = world();
    const wallet = Keypair.random();
    const { request } = await submitted(w, wallet);
    land(w, wallet);
    await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
    await expect(
      w.flow.prepare(
        { scope: w.t.scope, publicKey: Keypair.random().publicKey(), ...VERIFIED },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('over the daily reserve budget is denied', async () => {
    const w = world();
    // 10 XLM a day at about 1.5 XLM an account: the seventh does not fit.
    for (let n = 1; n <= 6; n += 1) await submitted(w, Keypair.random(), stranger(n));
    const sent = w.t.rpc.sent.length;
    await expect(submitted(w, Keypair.random(), stranger(7))).rejects.toBeInstanceOf(
      SponsorDeniedError,
    );
    expect(w.t.rpc.sent).toHaveLength(sent);
  });

  it('limits a principal still in business verification to testnet', async () => {
    const onTestnet = world();
    await expect(
      onTestnet.flow.prepare(
        {
          scope: onTestnet.t.scope,
          publicKey: Keypair.random().publicKey(),
          businessVerified: false,
        },
        OPTS,
      ),
    ).resolves.toMatchObject({ kind: 'stellar_transaction' });
    const onPubnet = world({ network: 'stellar:pubnet' });
    await expect(
      onPubnet.flow.prepare(
        {
          scope: onPubnet.t.scope,
          publicKey: Keypair.random().publicKey(),
          businessVerified: false,
        },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('refuses a secret, an account that already exists, and an unfunded sponsor', async () => {
    const w = world();
    const secret = Keypair.random().secret();
    const err = await rejected(
      w.flow.prepare({ scope: w.t.scope, publicKey: secret, ...VERIFIED }, OPTS),
    );
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(JSON.stringify((err as InvalidInputError).toJSON())).not.toContain(secret);

    const existing = Keypair.random();
    land(w, existing);
    const taken = await rejected(
      w.flow.prepare({ scope: w.t.scope, publicKey: existing.publicKey(), ...VERIFIED }, OPTS),
    );
    expect((taken as InvalidInputError).issues).toEqual(['publicKey (account_exists)']);

    w.t.rpc.entries.delete(accountKey(w.t.sponsor.publicKey()));
    await expect(
      w.flow.prepare(
        { scope: w.t.scope, publicKey: Keypair.random().publicKey(), ...VERIFIED },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(SponsorUnfundedError);
  });

  describe('what comes back from the wallet', () => {
    const prepared = async (w: World, wallet: Keypair) =>
      w.flow.prepare({ scope: w.t.scope, publicKey: wallet.publicKey(), ...VERIFIED }, OPTS);
    const submit = (w: World, requestId: string, signed: string) =>
      w.flow.submit({ scope: w.t.scope, requestId, signed, correlationId: 'test' }, OPTS);

    it('refuses an envelope the wallet did not sign, or signed by someone else', async () => {
      const w = world();
      const wallet = Keypair.random();
      const request = await prepared(w, wallet);
      await expect(
        submit(w, request.requestId, transactionOf(request).toXdr()),
      ).rejects.toBeInstanceOf(SignedPayloadMismatchError);
      await expect(
        submit(w, request.requestId, signedBy(request, Keypair.random())),
      ).rejects.toBeInstanceOf(SignedPayloadMismatchError);
      expect(w.signed).toEqual([]);
    });

    it('refuses a different transaction, however it is signed', async () => {
      const w = world();
      const wallet = Keypair.random();
      const request = await prepared(w, wallet);
      const other = await prepared(w, Keypair.random());
      await expect(submit(w, request.requestId, signedBy(other, wallet))).rejects.toBeInstanceOf(
        SignedPayloadMismatchError,
      );
      const base = TransactionBuilder.fromXDR(
        signedBy(request, wallet),
        PASSPHRASES[NETWORK],
      ) as unknown as { toEnvelope(): xdr.TransactionEnvelope };
      const bumped = TransactionBuilder.buildFeeBumpTransaction(
        w.t.sponsor.publicKey(),
        '200',
        base as never,
        PASSPHRASES[NETWORK],
      )
        .toEnvelope()
        .toXDR('base64');
      await expect(submit(w, request.requestId, bumped)).rejects.toBeInstanceOf(
        SignedPayloadMismatchError,
      );
    });

    it('refuses a request past its time bound, and one it does not know', async () => {
      const w = world();
      const wallet = Keypair.random();
      const request = await prepared(w, wallet);
      w.t.clock.now = NOW + 301n;
      await expect(submit(w, request.requestId, signedBy(request, wallet))).rejects.toBeInstanceOf(
        SigningRequestExpiredError,
      );
      await expect(submit(w, 'nope', 'x')).rejects.toBeInstanceOf(InvalidInputError);
    });

    it('sends once however often the same signature comes back', async () => {
      const w = world();
      const wallet = Keypair.random();
      const request = await prepared(w, wallet);
      const signed = signedBy(request, wallet);
      const first = await submit(w, request.requestId, signed);
      const again = await submit(w, request.requestId, signed);
      expect(again.txHash).toBe(first.txHash);
      expect(w.t.rpc.sent).toHaveLength(1);
      await expect(
        submit(w, request.requestId, signedBy(request, Keypair.random())),
      ).rejects.toBeInstanceOf(SignedPayloadMismatchError);
    });

    it('answers unknown when a crash left a claim with no transaction', async () => {
      const w = world();
      const wallet = Keypair.random();
      const request = await prepared(w, wallet);
      const signed = signedBy(request, wallet);
      await w.t.requests.claim(w.t.scope, request.requestId, signed);
      await expect(submit(w, request.requestId, signed)).rejects.toBeInstanceOf(
        SubmissionUnknownError,
      );
    });

    it('gives the slot back when the sponsor refuses or the network refuses, not otherwise', async () => {
      const denying: SignerProvider = {
        sign: () => Promise.reject(new SignerDeniedError({ network: NETWORK })),
        address: () => Promise.reject(new Error('unused')),
        health: () => Promise.reject(new Error('unused')),
      };
      const w = world({ signer: denying });
      await expect(submitted(w, Keypair.random())).rejects.toBeInstanceOf(SignerDeniedError);
      const after = await w.ledger.totals({
        network: NETWORK,
        since: 0n as UnixSeconds,
        intents: ['create_funding_account'],
      });
      expect(after.count).toBe(0);

      const lost = world();
      lost.t.rpc.sendResult = () => {
        throw new TypeError('socket hang up');
      };
      await expect(submitted(lost, Keypair.random())).rejects.toBeInstanceOf(Error);
      const kept = await lost.ledger.totals({
        network: NETWORK,
        since: 0n as UnixSeconds,
        intents: ['create_funding_account'],
      });
      // It may have landed, so the slot stays taken.
      expect(kept.count).toBe(1);
    });
  });

  describe('confirming the account', () => {
    it('records a good account with principal and project, and settles the reserve', async () => {
      const w = world();
      const wallet = Keypair.random();
      const { request, ref } = await submitted(w, wallet);
      land(w, wallet);
      const row = await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
      expect(row).toMatchObject({
        principalId: w.t.scope.principalId,
        projectId: w.t.scope.projectId,
        network: NETWORK,
        address: wallet.publicKey(),
        sponsor: w.t.sponsor.publicKey(),
        sponsorTxHash: ref.txHash,
        status: 'active',
        faults: [],
      });
      expect(w.flags).toEqual([]);
      const spent = await w.ledger.totals({
        network: NETWORK,
        since: 0n as UnixSeconds,
        intents: ['create_funding_account'],
      });
      // 1.5 XLM of reserves and four operations at the inclusion fee.
      expect(spent.stroops).toBe(15_000_400n);
    });

    describe('alongside the reconciliation sweep', () => {
      it('books the reserves and still confirms when the sweep sees it land first', async () => {
        const w = world();
        const wallet = Keypair.random();
        const { request, ref } = await submitted(w, wallet);
        land(w, wallet);
        w.t.rpc.txs.set(ref.txHash, { status: 'SUCCESS', ledger: 9, resultXdr: resultXdr(400n) });
        expect(await reconciled(w)).toBe('landed');
        expect((await fundingTotals(w)).stroops).toBe(15_000_400n);
        const row = await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
        expect(row.status).toBe('active');
        expect(await fundingTotals(w)).toEqual({ count: 1, stroops: 15_000_400n });
      });

      it('closes the record after a confirmation, without booking anything twice', async () => {
        const w = world();
        const wallet = Keypair.random();
        const { request, ref } = await submitted(w, wallet);
        land(w, wallet);
        w.t.rpc.txs.set(ref.txHash, { status: 'SUCCESS', ledger: 9, resultXdr: resultXdr(400n) });
        await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
        expect(await reconciled(w)).toBe('landed');
        expect(await fundingTotals(w)).toEqual({ count: 1, stroops: 15_000_400n });
      });

      it('gives the slot back when the sweep sees it fail first, so a retry is allowed', async () => {
        const w = world();
        const wallet = Keypair.random();
        const { request, ref } = await submitted(w, wallet);
        w.t.rpc.txs.set(ref.txHash, { status: 'FAILED', ledger: 9, resultXdr: resultXdr(400n) });
        expect(await reconciled(w)).toBe('failed');
        expect((await fundingTotals(w)).count).toBe(0);
        await expect(
          w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS),
        ).rejects.toBeInstanceOf(SubmissionRejectedError);
        expect((await fundingTotals(w)).count).toBe(0);
        await expect(submitted(w, Keypair.random())).resolves.toBeDefined();
      });

      it('gives the slot back for a failure whose fee cannot be read', async () => {
        const w = world();
        const { ref } = await submitted(w, Keypair.random());
        w.t.rpc.txs.set(ref.txHash, { status: 'FAILED', ledger: 9 });
        expect(await reconciled(w)).toBe('failed');
        expect((await fundingTotals(w)).count).toBe(0);
      });

      it('records what the sweep needs to prove a lost transaction is gone', async () => {
        const w = world();
        await submitted(w, Keypair.random());
        const [record] = [...w.t.store.submissions.values()];
        expect(record?.submittedAtLedger).not.toBeNull();
        expect(record?.reservationId).not.toBeNull();
      });
    });

    it('answers from the record when asked again', async () => {
      const w = world();
      const wallet = Keypair.random();
      const { request } = await submitted(w, wallet);
      land(w, wallet);
      const first = await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
      const calls = w.t.rpc.calls.length;
      const again = await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
      expect(again).toEqual(first);
      expect(w.t.rpc.calls).toHaveLength(calls);
    });

    it('rejects and flags any other shape, UJIRA as a signer above all', async () => {
      const w = world();
      const wallet = Keypair.random();
      const { request } = await submitted(w, wallet);
      land(w, wallet, {
        signers: [Keypair.fromPublicKey(w.t.sponsor.publicKey())],
      });
      const row = await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
      expect(row).toMatchObject({ status: 'rejected', faults: ['extra_signer'] });
      expect(w.flags.map((f) => f.faults)).toEqual([['extra_signer']]);
    });

    it('fails closed when the node does not say who sponsors the entry', async () => {
      const w = world();
      const wallet = Keypair.random();
      const { request } = await submitted(w, wallet);
      land(w, wallet, { noExt: true });
      const row = await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
      expect(row.status).toBe('rejected');
      expect(row.faults).toEqual(['account_sponsor', 'trustline_sponsor']);
    });

    it('gives the slot back when the transaction failed, and says so', async () => {
      const w = world();
      const wallet = Keypair.random();
      const { request, ref } = await submitted(w, wallet);
      w.t.rpc.txs.set(ref.txHash, { status: 'FAILED', ledger: 9 });
      const err = await rejected(
        w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS),
      );
      expect(err).toBeInstanceOf(SubmissionRejectedError);
      expect(w.rows.size).toBe(0);
      const left = await w.ledger.totals({
        network: NETWORK,
        since: 0n as UnixSeconds,
        intents: ['create_funding_account'],
      });
      expect(left.count).toBe(0);
    });

    it('refuses a request never submitted, a stranger, and an account not there', async () => {
      const w = world();
      const wallet = Keypair.random();
      const request = await w.flow.prepare(
        { scope: w.t.scope, publicKey: wallet.publicKey(), ...VERIFIED },
        OPTS,
      );
      await expect(
        w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS),
      ).rejects.toBeInstanceOf(InvalidInputError);
      await expect(
        w.flow.confirm({ scope: stranger(1), requestId: request.requestId }, OPTS),
      ).rejects.toBeInstanceOf(InvalidInputError);
      await w.flow.submit(
        {
          scope: w.t.scope,
          requestId: request.requestId,
          signed: signedBy(request, wallet),
          correlationId: 'test',
        },
        OPTS,
      );
      // Landed, but the node does not have the account yet.
      await expect(
        w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS),
      ).rejects.toBeInstanceOf(InvalidInputError);
    });
  });

  it('keeps its requests apart from mandate actions, in both directions', async () => {
    const w = world();
    const wallet = Keypair.random();
    const request = await w.flow.prepare(
      { scope: w.t.scope, publicKey: wallet.publicKey(), ...VERIFIED },
      OPTS,
    );
    const signed = signedBy(request, wallet);
    // The adapter would fee bump it, which is not how this transaction is paid for.
    await expect(
      w.t.adapter.submitSigned(
        { scope: w.t.scope, requestId: request.requestId, signed, correlationId: 'test' },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const action = await w.t.adapter.prepareMandateAction(
      {
        scope: w.t.scope,
        mandate: w.t.mandate,
        action: { op: 'pause' },
        signer: {
          kind: 'external',
          network: NETWORK,
          role: 'principal',
          address: { network: NETWORK, value: w.t.principal.publicKey() },
        },
      },
      OPTS,
    );
    await expect(
      w.flow.submit(
        { scope: w.t.scope, requestId: action.requestId, signed, correlationId: 'test' },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      w.flow.confirm({ scope: w.t.scope, requestId: action.requestId }, OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  describe('after the account is created', () => {
    const MANDATE_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 9));

    async function confirmed(): Promise<{ readonly w: World; readonly wallet: Keypair }> {
      const w = world();
      const wallet = Keypair.random();
      const { request } = await submitted(w, wallet);
      land(w, wallet);
      await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
      return { w, wallet };
    }

    const offered = async (w: World) =>
      (await w.flow.fundingOptions({ scope: w.t.scope, mandate: MANDATE_ADDRESS })).exchangeDeposit;

    it('writes and raises nothing while the account stays as it was', async () => {
      const { w } = await confirmed();
      const row = await w.flow.recheck(w.t.scope, OPTS);
      expect(row?.status).toBe('active');
      expect(w.checks).toEqual([]);
      expect(w.flags).toEqual([]);
    });

    it('an extra signer stops the account being offered and flags it', async () => {
      const { w, wallet } = await confirmed();
      expect(await offered(w)).not.toBeNull();
      land(w, wallet, { signers: [Keypair.random()] });
      const row = await w.flow.recheck(w.t.scope, OPTS);
      expect(row).toMatchObject({ status: 'changed', faults: ['extra_signer'] });
      expect(w.flags.map((flag) => flag.faults)).toEqual([['extra_signer']]);
      expect(await offered(w)).toBeNull();
    });

    it('a removed trustline stops the account being offered', async () => {
      const { w } = await confirmed();
      for (const key of [...w.t.rpc.entries.keys()]) {
        if (xdr.LedgerKey.fromXDR(key, 'base64').switch().name === 'trustline') {
          w.t.rpc.entries.delete(key);
        }
      }
      const row = await w.flow.recheck(w.t.scope, OPTS);
      expect(row).toMatchObject({ status: 'changed', faults: ['trustline_missing'] });
      expect(await offered(w)).toBeNull();
    });

    it('a merged account stops the account being offered', async () => {
      const { w, wallet } = await confirmed();
      w.t.rpc.entries.delete(accountKey(wallet.publicKey()));
      const row = await w.flow.recheck(w.t.scope, OPTS);
      expect(row).toMatchObject({ status: 'changed', faults: ['account_missing'] });
      expect(await offered(w)).toBeNull();
    });

    it('records and raises a change once, however often it is read', async () => {
      const { w, wallet } = await confirmed();
      land(w, wallet, { signers: [Keypair.random()] });
      await w.flow.recheck(w.t.scope, OPTS);
      await w.flow.recheck(w.t.scope, OPTS);
      expect(w.checks).toHaveLength(1);
      expect(w.flags).toHaveLength(1);
    });

    it('records a further change to what is wrong', async () => {
      const { w, wallet } = await confirmed();
      land(w, wallet, { signers: [Keypair.random()] });
      await w.flow.recheck(w.t.scope, OPTS);
      w.t.rpc.entries.delete(accountKey(wallet.publicKey()));
      const row = await w.flow.recheck(w.t.scope, OPTS);
      expect(row?.faults).toEqual(['account_missing']);
      expect(w.checks).toHaveLength(2);
    });

    it('goes back to being offered once a read finds the shape it verified', async () => {
      const { w, wallet } = await confirmed();
      land(w, wallet, { signers: [Keypair.random()] });
      await w.flow.recheck(w.t.scope, OPTS);
      land(w, wallet);
      const row = await w.flow.recheck(w.t.scope, OPTS);
      expect(row).toMatchObject({ status: 'active', faults: [] });
      expect(w.checks).toHaveLength(2);
      expect(w.flags).toHaveLength(1);
      expect(await offered(w)).not.toBeNull();
    });

    it('does not read an account rejected at creation back into use', async () => {
      const w = world();
      const wallet = Keypair.random();
      const { request } = await submitted(w, wallet);
      land(w, wallet, { signers: [Keypair.random()] });
      await w.flow.confirm({ scope: w.t.scope, requestId: request.requestId }, OPTS);
      land(w, wallet);
      const calls = w.t.rpc.calls.length;
      const row = await w.flow.recheck(w.t.scope, OPTS);
      expect(row?.status).toBe('rejected');
      expect(w.t.rpc.calls).toHaveLength(calls);
      expect(w.checks).toEqual([]);
    });

    it('has nothing to read for a tenant with no account', async () => {
      const { w } = await confirmed();
      expect(await w.flow.recheck(stranger(11), OPTS)).toBeNull();
      expect(await world().flow.recheck(stranger(12), OPTS)).toBeNull();
    });
  });

  describe('what a principal is offered', () => {
    const MANDATE = StrKey.encodeContract(Buffer.alloc(32, 9));

    function rowFor(w: World, change: Partial<ForwarderRecord> = {}): ForwarderRecord {
      return {
        principalId: w.t.scope.principalId,
        projectId: w.t.scope.projectId,
        network: NETWORK,
        address: Keypair.random().publicKey(),
        sponsor: w.t.sponsor.publicKey(),
        sponsorTxHash: 'ab'.repeat(32),
        status: 'active',
        faults: [],
        ...change,
      };
    }

    function holding(w: World, row: ForwarderRecord): void {
      w.rows.set(`${row.principalId}|${row.network}`, row);
    }

    it('never offers the mandate as the exchange address when there is no account', async () => {
      const w = world();
      expect(await w.flow.account(w.t.scope)).toBeNull();
      const view = await w.flow.fundingOptions({ scope: w.t.scope, mandate: MANDATE });
      expect(view.exchangeDeposit).toBeNull();
      expect(view.walletFunding.address).toEqual({ network: NETWORK, value: MANDATE });
      expect(view.walletFunding.label).toBe('Stellar contract address, fund from your wallet');
    });

    it('offers an active account as the exchange address', async () => {
      const w = world();
      const row = rowFor(w);
      holding(w, row);
      expect(await w.flow.account(w.t.scope)).toEqual(row);
      const view = await w.flow.fundingOptions({ scope: w.t.scope, mandate: MANDATE });
      expect(view.exchangeDeposit).toEqual({ network: NETWORK, value: row.address });
      expect(view.walletFunding.address.value).toBe(MANDATE);
    });

    it('shows a rejected account as such but never offers it', async () => {
      const w = world();
      const row = rowFor(w, { status: 'rejected', faults: ['extra_signer'] });
      holding(w, row);
      expect(await w.flow.account(w.t.scope)).toEqual(row);
      const view = await w.flow.fundingOptions({ scope: w.t.scope, mandate: MANDATE });
      expect(view.exchangeDeposit).toBeNull();
    });

    it("does not give one project another project's account, but refuses it a second", async () => {
      const w = world();
      const elsewhere = rowFor(w, { projectId: stranger(9).projectId });
      holding(w, elsewhere);
      expect(await w.flow.account(w.t.scope)).toBeNull();
      const view = await w.flow.fundingOptions({ scope: w.t.scope, mandate: MANDATE });
      expect(view.exchangeDeposit).toBeNull();
      await expect(
        w.flow.prepare(
          { scope: w.t.scope, publicKey: Keypair.random().publicKey(), ...VERIFIED },
          OPTS,
        ),
      ).rejects.toBeInstanceOf(SponsorDeniedError);
    });

    it('asks the store under the tenant it was given, so no other principal is read', async () => {
      const w = world();
      holding(w, rowFor(w));
      const other = stranger(10);
      expect(await w.flow.account(other)).toBeNull();
      const view = await w.flow.fundingOptions({ scope: other, mandate: MANDATE });
      expect(view.exchangeDeposit).toBeNull();
    });
  });
});
