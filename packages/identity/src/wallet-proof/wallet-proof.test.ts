// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { RpcTimeoutError, TenantMismatchError } from '@ujira/chain-adapter';
import type { UnixSeconds, Uuid } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import {
  IdentityConflictError,
  IdentityInputError,
  IdentityTenantMismatchError,
  ProviderUnavailableError,
  WalletMethodNotFoundError,
} from '../errors.js';
import type { IdentityStore } from '../ports.js';
import {
  ANCHOR_RAIL,
  TEST_NOW,
  accountOf,
  fakeWalletSignature,
  methodRow,
  newId,
  newScope,
  recipientRow,
  verificationRow,
  walletProofWorld,
} from '../testing/index.js';
import type { WalletProofWorld } from '../testing/index.js';

import { createWalletProofFlow, WALLET_CHALLENGE_TTL_SECONDS } from './service.js';

async function submitted(w: WalletProofWorld) {
  const issued = await w.issue();
  return { issued, proof: w.proofOf(issued) };
}

async function verificationOf(w: WalletProofWorld) {
  return w.store.latestVerification(w.scope, w.method.id);
}

describe('createWalletChallenge', () => {
  it('issues the adapter text for the method and stores only hashes of it', async () => {
    const w = walletProofWorld();
    const issued = await w.issue();
    expect(issued.message).toContain(w.method.destination.address.value);
    expect(issued.message).toContain(w.recipient.recipientRef);
    expect(issued.message).toContain(issued.nonce);
    expect(issued.expiresAt).toBe(TEST_NOW + BigInt(WALLET_CHALLENGE_TTL_SECONDS));

    const [row] = w.proofs.rows(w.scope);
    expect(row).toMatchObject({
      id: issued.challengeId,
      methodId: w.method.id,
      purpose: 'payout_destination',
      consumedAt: null,
      expiresAt: issued.expiresAt,
    });
    const stored = JSON.stringify(row, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(stored).not.toContain(issued.nonce);
    expect(stored).not.toContain(issued.message);
    expect(row?.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.messageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the destination tag into the challenge', async () => {
    const w = walletProofWorld();
    const tagged = methodRow(w.scope, w.recipient.id, {
      destination: { ...w.method.destination, tag: 7n },
    });
    w.store.putPayoutMethod(tagged);
    const issued = await w.flow.createWalletChallenge(w.ctx, {
      recipientId: w.recipient.id,
      methodId: tagged.id,
    });
    expect(issued.message).toContain(' 7');
    expect(w.proofs.rows(w.scope).at(-1)?.tag).toBe(7n);
  });

  it('a method that is missing, disabled or another recipient is not found', async () => {
    const w = walletProofWorld();
    const disabled = methodRow(w.scope, w.recipient.id, { status: 'disabled' });
    const foreign = methodRow(w.scope, newId());
    w.store.putPayoutMethod(disabled).putPayoutMethod(foreign);
    const asks = [
      { recipientId: w.recipient.id, methodId: newId() },
      { recipientId: w.recipient.id, methodId: disabled.id },
      { recipientId: w.recipient.id, methodId: foreign.id },
      { recipientId: newId(), methodId: w.method.id },
    ];
    for (const ask of asks) {
      await expect(w.flow.createWalletChallenge(w.ctx, ask)).rejects.toThrow(
        WalletMethodNotFoundError,
      );
    }
    expect(w.proofs.rows(w.scope)).toEqual([]);
  });

  it('another tenant cannot ask for a challenge on this method', async () => {
    const w = walletProofWorld();
    await expect(
      w.flow.createWalletChallenge(
        { scope: newScope(), correlationId: 'intruder' },
        { recipientId: w.recipient.id, methodId: w.method.id },
      ),
    ).rejects.toThrow(WalletMethodNotFoundError);
  });

  it('refuses malformed ids by field, and a store that crosses tenants', async () => {
    const w = walletProofWorld();
    const error = await w.flow
      .createWalletChallenge(w.ctx, { recipientId: 'x' as Uuid, methodId: w.method.id })
      .catch((e: unknown) => e);
    expect((error as IdentityInputError).issues).toEqual(['recipientId (invalid_format)']);

    const leaky = new Proxy(w.store, {
      get(target, key): unknown {
        if (key === 'recipient') return () => Promise.resolve(recipientRow(newScope()));
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as IdentityStore;
    const flow = createWalletProofFlow({ ...w.ports, store: leaky });
    await expect(
      flow.createWalletChallenge(w.ctx, { recipientId: w.recipient.id, methodId: w.method.id }),
    ).rejects.toThrow(IdentityTenantMismatchError);
  });

  it('a repeated nonce is refused by the store', async () => {
    const w = walletProofWorld();
    await w.issue();
    const [row] = w.proofs.rows(w.scope);
    if (row === undefined) throw new Error('no row');
    await expect(w.proofs.insertChallenge({ ...row, id: newId() })).rejects.toThrow(
      IdentityConflictError,
    );
  });
});

describe('submitWalletProof', () => {
  it('records the proof as a wallet signature, with its signer and challenge', async () => {
    const w = walletProofWorld();
    const { issued, proof } = await submitted(w);
    const result = await w.flow.submitWalletProof(w.ctx, proof);
    const signer = w.method.destination.address.value;
    expect(result).toMatchObject({ accepted: true, signerKey: signer });
    expect(await verificationOf(w)).toMatchObject({
      scope: w.scope,
      methodId: w.method.id,
      level: 'wallet_signature',
      destination: w.method.destination,
      signerKey: signer,
      scheme: 'sep53',
      challengeId: issued.challengeId,
      signature: proof.signature,
      partnerRef: null,
      recordedAt: TEST_NOW,
    });
    expect(w.proofs.rows(w.scope)[0]?.consumedAt).toBe(TEST_NOW);
    expect(w.chain.checks).toEqual([
      { destination: w.method.destination, asset: 'USDC', proofSigner: signer },
    ]);
  });

  it('records the added signer the wallet reports', async () => {
    const w = walletProofWorld();
    const issued = await w.issue();
    const signer = accountOf('added signer');
    const result = await w.flow.submitWalletProof(w.ctx, {
      ...w.proofOf(issued),
      signature: fakeWalletSignature(issued.message, signer),
      signer,
    });
    expect(result).toMatchObject({ accepted: true, signerKey: signer });
    expect((await verificationOf(w))?.signerKey).toBe(signer);
  });

  it('second submit of the same challenge is refused', async () => {
    const w = walletProofWorld();
    const { proof } = await submitted(w);
    const first = await w.flow.submitWalletProof(w.ctx, proof);
    expect(first.accepted).toBe(true);
    const row = await verificationOf(w);
    expect(await w.flow.submitWalletProof(w.ctx, proof)).toEqual({
      accepted: false,
      code: 'WALLET_PROOF_INVALID',
      reason: 'ALREADY_USED',
    });
    expect(await verificationOf(w)).toBe(row);
  });

  it('two proofs racing for one challenge record one row', async () => {
    const w = walletProofWorld();
    const { proof } = await submitted(w);
    const results = await Promise.all([
      w.flow.submitWalletProof(w.ctx, proof),
      w.flow.submitWalletProof(w.ctx, proof),
    ]);
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    expect(results.filter((r) => !r.accepted)).toEqual([
      { accepted: false, code: 'WALLET_PROOF_INVALID', reason: 'ALREADY_USED' },
    ]);
  });

  it('submit after 600 seconds gives WALLET_PROOF_EXPIRED', async () => {
    const w = walletProofWorld();
    const { issued, proof } = await submitted(w);
    w.clock.set((issued.expiresAt - 1n) as UnixSeconds);
    w.chain.verdict = 'BAD_SIGNATURE';
    expect(await w.flow.submitWalletProof(w.ctx, proof)).toMatchObject({
      code: 'WALLET_PROOF_INVALID',
    });
    w.chain.verdict = null;
    w.clock.set(issued.expiresAt);
    expect(await w.flow.submitWalletProof(w.ctx, proof)).toEqual({
      accepted: false,
      code: 'WALLET_PROOF_EXPIRED',
      reason: null,
    });
    expect(await verificationOf(w)).toBeNull();
    expect(w.proofs.rows(w.scope)[0]?.consumedAt).toBeNull();
  });

  it('an unknown challenge, a changed text or nonce, and a bad signature are invalid', async () => {
    const w = walletProofWorld();
    const { proof } = await submitted(w);
    const cases = [
      [{ ...proof, challengeId: newId() }, null],
      [{ ...proof, message: `${proof.message}x` }, 'MESSAGE_MISMATCH'],
      [{ ...proof, nonce: 'other-nonce' }, 'MESSAGE_MISMATCH'],
      [{ ...proof, signature: 'not-the-signature' }, 'BAD_SIGNATURE'],
    ] as const;
    for (const [attempt, reason] of cases) {
      expect(await w.flow.submitWalletProof(w.ctx, attempt)).toEqual({
        accepted: false,
        code: 'WALLET_PROOF_INVALID',
        reason,
      });
    }
    expect(await verificationOf(w)).toBeNull();
  });

  it('another tenant cannot use a challenge, and a failed proof can be sent again', async () => {
    const w = walletProofWorld();
    const { proof } = await submitted(w);
    expect(
      await w.flow.submitWalletProof({ scope: newScope(), correlationId: 'intruder' }, proof),
    ).toEqual({ accepted: false, code: 'WALLET_PROOF_INVALID', reason: null });
    expect(w.chain.verifications).toEqual([]);

    w.chain.destination = { receivable: false, reason: 'NO_TRUSTLINE', proofSigner: 'current' };
    expect((await w.flow.submitWalletProof(w.ctx, proof)).accepted).toBe(false);
    w.chain.destination = { receivable: true, proofSigner: 'current' };
    expect((await w.flow.submitWalletProof(w.ctx, proof)).accepted).toBe(true);
  });

  it('a method disabled or moved after the challenge is invalid', async () => {
    const disabled = walletProofWorld();
    const first = await submitted(disabled);
    disabled.store.putPayoutMethod({ ...disabled.method, status: 'disabled' });
    expect(await disabled.flow.submitWalletProof(disabled.ctx, first.proof)).toEqual({
      accepted: false,
      code: 'WALLET_PROOF_INVALID',
      reason: 'METHOD_CHANGED',
    });

    const moved = walletProofWorld();
    const second = await submitted(moved);
    moved.store.putPayoutMethod({
      ...moved.method,
      destination: { ...moved.method.destination, tag: 9n },
    });
    expect(await moved.flow.submitWalletProof(moved.ctx, second.proof)).toMatchObject({
      reason: 'METHOD_CHANGED',
    });
    expect(moved.chain.verifications).toEqual([]);
  });

  it.each([
    ['NO_TRUSTLINE'],
    ['TRUSTLINE_NOT_AUTHORIZED'],
    ['TRUSTLINE_LIMIT'],
    ['DESTINATION_IS_ISSUER'],
  ] as const)(
    '%s gives DESTINATION_NOT_RECEIVABLE and writes no verification row',
    async (reason) => {
      const w = walletProofWorld();
      const { proof } = await submitted(w);
      w.chain.destination = { receivable: false, reason, proofSigner: 'current' };
      expect(await w.flow.submitWalletProof(w.ctx, proof)).toEqual({
        accepted: false,
        code: 'DESTINATION_NOT_RECEIVABLE',
        reason,
      });
      expect(await verificationOf(w)).toBeNull();
      expect(w.proofs.rows(w.scope)[0]?.consumedAt).toBeNull();
    },
  );

  it('an account that does not exist is not receivable', async () => {
    const w = walletProofWorld();
    const { proof } = await submitted(w);
    w.chain.verdict = 'ACCOUNT_NOT_FOUND';
    expect(await w.flow.submitWalletProof(w.ctx, proof)).toEqual({
      accepted: false,
      code: 'DESTINATION_NOT_RECEIVABLE',
      reason: 'ACCOUNT_NOT_FOUND',
    });
    expect(w.chain.checks).toEqual([]);
  });

  it('a removed signer is not authorized, from the proof or from the fresh read', async () => {
    const atProof = walletProofWorld();
    const first = await submitted(atProof);
    atProof.chain.verdict = 'SIGNER_NOT_AUTHORIZED';
    expect(await atProof.flow.submitWalletProof(atProof.ctx, first.proof)).toEqual({
      accepted: false,
      code: 'WALLET_SIGNER_NOT_AUTHORIZED',
      reason: null,
    });

    const atRead = walletProofWorld();
    const second = await submitted(atRead);
    atRead.chain.destination = { receivable: true, proofSigner: 'not_current' };
    expect(await atRead.flow.submitWalletProof(atRead.ctx, second.proof)).toMatchObject({
      code: 'WALLET_SIGNER_NOT_AUTHORIZED',
    });
    expect(await verificationOf(atRead)).toBeNull();
  });

  it('an expiry the adapter finds is expired too', async () => {
    const w = walletProofWorld();
    const { proof } = await submitted(w);
    w.chain.verdict = 'EXPIRED';
    expect(await w.flow.submitWalletProof(w.ctx, proof)).toMatchObject({
      code: 'WALLET_PROOF_EXPIRED',
    });
  });

  it('a chain outage is unavailable, and leaves the challenge open', async () => {
    const reads = [
      (w: WalletProofWorld) => {
        w.chain.verifyFailure = new RpcTimeoutError();
      },
      (w: WalletProofWorld) => {
        w.chain.checkFailure = new RpcTimeoutError();
      },
      (w: WalletProofWorld) => {
        w.chain.checkFailure = 'hang';
      },
    ];
    for (const breakIt of reads) {
      const w = walletProofWorld();
      const { proof } = await submitted(w);
      breakIt(w);
      await expect(w.flow.submitWalletProof(w.ctx, proof)).rejects.toThrow(
        ProviderUnavailableError,
      );
      expect(await verificationOf(w)).toBeNull();
      expect(w.proofs.rows(w.scope)[0]?.consumedAt).toBeNull();
    }
  });

  it('a chain fault that is not an outage reaches the caller as it is', async () => {
    const w = walletProofWorld();
    const { proof } = await submitted(w);
    w.chain.verifyFailure = new TenantMismatchError();
    await expect(w.flow.submitWalletProof(w.ctx, proof)).rejects.toThrow(TenantMismatchError);
  });

  it('refuses a malformed proof by field, without echoing it', async () => {
    const w = walletProofWorld();
    const { proof } = await submitted(w);
    const error = await w.flow
      .submitWalletProof(w.ctx, { ...proof, signature: 'x'.repeat(2_049) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityInputError);
    expect((error as IdentityInputError).issues).toEqual(['signature (too_big)']);
  });
});

describe('the store', () => {
  it('a proof for a challenge it does not hold consumes nothing', async () => {
    const w = walletProofWorld();
    const row = verificationRow(w.method);
    expect(await w.proofs.recordProof(w.scope, newId(), TEST_NOW, row)).toBe('already_consumed');
    expect(await verificationOf(w)).toBeNull();
    expect(w.proofs.rows(newScope())).toEqual([]);
  });
});

describe('an anchor method', () => {
  it('proves the same way: the flow does not ask what rail a method is on', async () => {
    const w = walletProofWorld();
    w.store.putPayoutMethod({ ...w.method, rail: ANCHOR_RAIL, anchorId: 'anchor-one' });
    const { proof } = await submitted(w);
    expect((await w.flow.submitWalletProof(w.ctx, proof)).accepted).toBe(true);
  });
});
