// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The fake adapter's wallet proofs and destinations, in the cases a test
 * above the adapter needs to set up: accounts and trustlines that are
 * absent or restricted, an added signer, an activation that changes what
 * the ledger holds, and an outage. The conformance suite covers the
 * behaviour every adapter shares.
 */

import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { ChainUnavailableError, InvalidInputError } from '../errors.js';
import { parsePublicConfig } from '../wallet-proof.js';
import { FakeChainAdapter } from './fake-adapter.js';
import { createFakeWorld, fakeAdapterHarness } from './fake-world.js';

const OPTS = { correlationId: 'corr-1' };

function challengeFor(h: ReturnType<typeof fakeAdapterHarness>, address: string) {
  return h.adapter.walletProofChallenge({
    network: h.adapter.network,
    address,
    purpose: 'member_wallet',
    recipientRef: `0x${'ef'.repeat(32)}`,
    tag: null,
    requestId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
  });
}

describe('the fake ledger behind wallet proofs and destinations', () => {
  it('reports what a test says the ledger holds', async () => {
    const h = fakeAdapterHarness();
    const { net } = h.world;
    const wallet = h.wallet('recipient');
    const check = () =>
      h.adapter.checkDestination(
        { destination: { address: wallet, tag: null }, asset: 'USDC' },
        OPTS,
      );

    net.setLedgerTrustline(wallet.value, null);
    expect(await check()).toMatchObject({ receivable: false, reason: 'NO_TRUSTLINE' });

    net.setLedgerAccount(wallet.value, null);
    expect(await check()).toMatchObject({ receivable: false, reason: 'ACCOUNT_NOT_FOUND' });

    net.activateRecipient(wallet.value);
    expect(await check()).toMatchObject({ receivable: true });
  });

  it('checks the amount against the room on the trustline', async () => {
    const h = fakeAdapterHarness();
    const wallet = h.wallet('recipient');
    h.world.net.setLedgerTrustline(wallet.value, {
      accountId: wallet.value,
      asset: { code: 'USDC', issuer: h.world.net.issuer },
      balance: 0n,
      limit: 100n,
      buyingLiabilities: 0n,
      flags: 1,
    });
    const chain = h.adapter.chain;
    const check = (amount: bigint) =>
      h.adapter.checkDestination(
        {
          destination: { address: wallet, tag: null },
          asset: 'USDC',
          amount: tokenAmount(amount, 'USDC', chain),
        },
        OPTS,
      );
    expect(await check(100n)).toMatchObject({ receivable: true });
    expect(await check(101n)).toMatchObject({ reason: 'TRUSTLINE_LIMIT' });
  });

  it('applies the signer rules to a proof', async () => {
    const h = fakeAdapterHarness();
    const wallet = h.wallet('account');
    const added = h.wallet('added signer');
    const challenge = challengeFor(h, wallet.value);
    const signature = await h.signMessage(added, challenge.text);
    const req = { challenge, signedText: challenge.text, signature, signer: added.value };

    expect(await h.adapter.verifyWalletProof(req, OPTS)).toEqual({
      status: 'invalid',
      reason: 'SIGNER_NOT_AUTHORIZED',
    });
    h.world.net.setLedgerAccount(wallet.value, {
      accountId: wallet.value,
      masterWeight: 0,
      thresholds: { low: 1, medium: 1, high: 1 },
      signers: [{ kind: 'ed25519', key: added.value, weight: 1 }],
    });
    expect(await h.adapter.verifyWalletProof(req, OPTS)).toEqual({
      status: 'valid',
      scheme: 'sep53',
      signer: added.value,
    });
    h.world.net.setLedgerAccount(wallet.value, null);
    expect(await h.adapter.verifyWalletProof(req, OPTS)).toEqual({
      status: 'invalid',
      reason: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('reads nothing for an address that has no key', async () => {
    const h = fakeAdapterHarness();
    const contract = h.world.net.contract('wallet');
    const challenge = challengeFor(h, contract);
    expect(
      await h.adapter.verifyWalletProof(
        { challenge, signedText: challenge.text, signature: 'unused' },
        OPTS,
      ),
    ).toEqual({ status: 'invalid', reason: 'UNSUPPORTED_ACCOUNT' });
  });

  it('activates a recipient once the signed request is submitted', async () => {
    const h = fakeAdapterHarness();
    const { net } = h.world;
    const wallet = h.wallet('new recipient');
    net.setLedgerAccount(wallet.value, null);
    net.setLedgerTrustline(wallet.value, null);
    const request = await h.adapter.prepareRecipientActivation(
      {
        scope: h.scope,
        destination: { address: wallet, tag: null },
        asset: 'USDC',
        createAccount: true,
        reservationIds: [],
      },
      OPTS,
    );
    const check = () =>
      h.adapter.checkDestination(
        { destination: { address: wallet, tag: null }, asset: 'USDC' },
        OPTS,
      );
    expect(await check()).toMatchObject({ reason: 'ACCOUNT_NOT_FOUND' });
    await h.adapter.submitSigned(
      {
        scope: h.scope,
        requestId: request.requestId,
        signed: await h.sign(request, wallet),
        correlationId: OPTS.correlationId,
      },
      OPTS,
    );
    expect(await check()).toMatchObject({ receivable: true });
  });

  it('takes the host from its public config', () => {
    const world = createFakeWorld();
    const adapter = new FakeChainAdapter(world.net, {
      store: world.store,
      signer: world.signer,
      sponsorship: world.sponsorship,
      alerts: world.alerts,
      publicConfig: parsePublicConfig({ widgetHost: 'app.ujira.co' }),
    });
    const challenge = adapter.walletProofChallenge({
      network: adapter.network,
      address: world.net.account('someone').address,
      purpose: 'agent_link',
      recipientRef: `0x${'ef'.repeat(32)}`,
      tag: null,
      requestId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
    });
    expect(challenge.text.startsWith('app.ujira.co wants you')).toBe(true);
  });

  it('refuses a challenge for another network and a request it cannot serve', async () => {
    const h = fakeAdapterHarness();
    const wallet = h.wallet('someone');
    const other = createFakeWorld({ network: 'stellar:pubnet' });
    expect(() =>
      other.adapter.walletProofChallenge({
        network: 'stellar:testnet',
        address: wallet.value,
        purpose: 'agent_link',
        recipientRef: `0x${'ef'.repeat(32)}`,
        tag: null,
        requestId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
      }),
    ).toThrow(InvalidInputError);
    await expect(
      h.adapter.checkDestination(
        { destination: { address: wallet, tag: null }, asset: 'EURC' as unknown as 'USDC' },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('reports an outage from every read', async () => {
    const h = fakeAdapterHarness();
    const wallet = h.wallet('someone');
    const challenge = challengeFor(h, wallet.value);
    const signature = await h.signMessage(wallet, challenge.text);
    h.faults?.chainDown(true);
    await expect(
      h.adapter.verifyWalletProof({ challenge, signedText: challenge.text, signature }, OPTS),
    ).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(
      h.adapter.checkDestination(
        { destination: { address: wallet, tag: null }, asset: 'USDC' },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(
      h.adapter.prepareRecipientActivation(
        {
          scope: h.scope,
          destination: { address: wallet, tag: null },
          asset: 'USDC',
          createAccount: false,
          reservationIds: [],
        },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});
