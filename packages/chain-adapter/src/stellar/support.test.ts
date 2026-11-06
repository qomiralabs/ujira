// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The entry's exports, signature attachment, and the test ports the other
// suites lean on, so a broken fake cannot make them pass for the wrong reason.

import {
  Account,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
} from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import {
  SignerAddressMismatchError,
  SignerDeniedError,
  SubmissionRejectedError,
} from '../errors.js';
import type { SignerRef } from '../signer.js';
import type { TenantScope, UnixSeconds, Uuid } from '../types.js';
import * as entry from './index.js';
import { DEFAULT_WAIT } from './mandate-adapter.js';
import { keypairSigner, memoryStore, recordingSponsorship } from './test-ports.js';
import { NETWORK, OPTS, addAccount } from './test-adapter.js';
import { FIXTURE_FACTORY, FakeRpc, loadReadFixture } from './test-rpc.js';
import { PASSPHRASES, accountBalance, attach, readTx, returned, simulate } from './tx.js';

const scope: TenantScope = {
  principalId: '11111111-1111-4111-8111-111111111111' as Uuid,
  projectId: '22222222-2222-4222-8222-222222222222' as Uuid,
};

function paymentTx(source: Keypair) {
  return new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: PASSPHRASES[NETWORK],
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '5' }))
    .setTimeout(30)
    .build();
}

describe('the stellar entry', { timeout: 30_000 }, () => {
  it('exports the adapter, the stores and the policy, and nothing that needs the SDK types', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'ACCOUNT_LAYOUT',
      'CONTRACT_ADDRESS_LABEL',
      'INSTANCE_TTL_EXTEND_LEDGERS',
      'RECORD_TTL_MARGIN_SECONDS',
      'REVIEWED_WALLET_CODE',
      'StellarMandateAdapter',
      'WALLET_REFUSALS',
      'accountBalance',
      'accountLedgerKey',
      'accountSequenceOf',
      'assertTestnet',
      'buildLayoutTransaction',
      'buildRecipientActivation',
      'checkSingleKey',
      'checkStellarDestination',
      'checkStellarWalletProof',
      'checkWalletChange',
      'checkWalletTrust',
      'createFundingAccountFlow',
      'createMemorySigningRequestStore',
      'createStellarEventIntake',
      'createStellarEventSource',
      'createStellarLedgerReader',
      'createStellarRpc',
      'createStellarSweepChain',
      'extensionPlan',
      'fateOf',
      'fewestSignatures',
      'guardWalletChange',
      'guardWalletForMandate',
      'horizonDexSource',
      'layoutChanges',
      'ledgerEventOf',
      'mandateAddressOf',
      'parseForwarderRequest',
      'publicKeyOfSecret',
      'readAccountLayout',
      'reflectorOracleSource',
      'resultCodeOf',
      'scanLedgerEvents',
      'setUpAccounts',
      'signTestnetTransaction',
      'stellarFundingView',
      'stellarTenantTag',
      'verifyAccounts',
      'verifyStellarWalletProof',
    ]);
  });

  it('waits for restore transactions with a real timer by default', async () => {
    expect(DEFAULT_WAIT.attempts).toBeGreaterThan(1);
    await expect(DEFAULT_WAIT.sleep(0)).resolves.toBeUndefined();
  });
});

describe('attach', { timeout: 30_000 }, () => {
  it('attaches a signature made by the address over the hash, and refuses any other', () => {
    const key = Keypair.random();
    const tx = paymentTx(key);
    attach(tx, key.publicKey(), {
      kind: 'ed25519',
      signature: key.sign(tx.hash()),
      publicKey: key.rawPublicKey(),
    });
    expect(tx.signatures).toHaveLength(1);
    expect(() => {
      attach(tx, Keypair.random().publicKey(), {
        kind: 'ed25519',
        signature: key.sign(tx.hash()),
        publicKey: key.rawPublicKey(),
      });
    }).toThrow(SignerAddressMismatchError);
    expect(() => {
      attach(tx, key.publicKey(), {
        kind: 'ed25519',
        signature: key.sign(new Uint8Array(32)),
        publicKey: key.rawPublicKey(),
      });
    }).toThrow(SignerDeniedError);
  });
});

describe('accountBalance', { timeout: 30_000 }, () => {
  it('reads the balance of an account, and nothing for one that is missing', async () => {
    const rpc = FakeRpc.fromFixture(loadReadFixture(), { principal: Keypair.random().publicKey() });
    const key = Keypair.random().publicKey();
    expect(await accountBalance(rpc, key, OPTS)).toBeNull();
    addAccount(rpc, key, 1n);
    expect(await accountBalance(rpc, key, OPTS)).toBe(100_000_000n);
  });
});

describe('simulate', { timeout: 30_000 }, () => {
  it('reads a failure without events as a rejection, and a result without a value as void', async () => {
    const rpc = FakeRpc.fromFixture(loadReadFixture(), { principal: Keypair.random().publicKey() });
    const tx = readTx(NETWORK, { contract: FIXTURE_FACTORY, fn: 'version', args: [] });
    rpc.onSimulate = () => ({
      id: '1',
      latestLedger: 1,
      error: 'HostError: Error(Budget, ExceededLimit)',
    });
    await expect(simulate(rpc, NETWORK, tx, FIXTURE_FACTORY, OPTS)).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );
    rpc.onSimulate = () => ({
      id: '1',
      latestLedger: 1,
      minResourceFee: '0',
      transactionData: new SorobanDataBuilder().build().toXdr('base64'),
    });
    expect(returned(await simulate(rpc, NETWORK, tx, FIXTURE_FACTORY, OPTS)).type).toBe('scvVoid');
  });
});

describe('test ports', { timeout: 30_000 }, () => {
  it('records submissions once per hash and only patches the owning tenant', async () => {
    const store = memoryStore(NETWORK, [], () => 1n as UnixSeconds);
    const record = {
      scope,
      network: NETWORK,
      txHash: 'h',
      op: 'pause',
      mandate: null,
      payoutId: null,
      attempt: null,
      signerAddress: 'G',
      sequenceOrNonce: 1n,
      maxTime: null,
      state: 'built',
      landedAtHeight: null,
      errorCode: null,
      specCode: null,
      replacesTxHash: null,
      submittedAtLedger: null,
      reservationId: null,
      correlationId: 'c',
      createdAt: 1n as UnixSeconds,
    } as const;
    await store.recordSubmission(record);
    await expect(store.recordSubmission(record)).rejects.toThrow('duplicate');
    await expect(
      store.updateSubmission({ ...scope, projectId: scope.principalId }, NETWORK, 'h', {
        state: 'landed',
      }),
    ).rejects.toThrow('no such submission');
    await expect(store.updateSubmission(scope, NETWORK, 'other', {})).rejects.toThrow(
      'no such submission',
    );
    await expect(store.leaseExecutor(NETWORK, 1)).rejects.toThrow('no executor');
    await expect(store.unresolvedSubmissions(NETWORK, 1, 1)).rejects.toThrow('not used');
  });

  it('records sponsorship calls and can deny', async () => {
    const sponsorship = recordingSponsorship(true);
    const fee = { network: NETWORK, asset: 'XLM', amount: 1n, scale: 7 } as const;
    await expect(
      sponsorship.reserve({
        scope,
        network: NETWORK,
        reservationId: 'r',
        intent: 'pause',
        maxFee: fee,
      }),
    ).rejects.toThrow('denied');
    await sponsorship.settle({ scope, reservationId: 'r', actualFee: fee });
    expect(sponsorship.calls.map((c) => c.kind)).toEqual(['reserve', 'settle']);
  });

  it('signs only transactions and fee bumps, with the key for the ref', async () => {
    const sponsor = Keypair.random();
    const signer = keypairSigner(NETWORK, new Map([['fee_sponsor', sponsor]]));
    const ref: SignerRef = { kind: 'fee_sponsor', network: NETWORK };
    expect((await signer.address(ref, OPTS)).value).toBe(sponsor.publicKey());
    const tx = paymentTx(sponsor);
    const signed = await signer.sign(
      ref,
      { kind: 'stellar_tx', network: NETWORK, xdr: tx.toXdr() },
      OPTS,
    );
    expect(sponsor.verify(tx.hash(), signed.signature)).toBe(true);
    await expect(
      signer.sign(ref, { kind: 'sep10_challenge', network: NETWORK, xdr: tx.toXdr() }, OPTS),
    ).rejects.toBeInstanceOf(SignerDeniedError);
    await expect(
      signer.address({ kind: 'attester', network: NETWORK }, OPTS),
    ).rejects.toBeInstanceOf(SignerDeniedError);
    await expect(signer.health(OPTS)).rejects.toThrow('not used');
  });
});
