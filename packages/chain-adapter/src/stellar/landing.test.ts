// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { TransactionBuilder } from '@stellar/stellar-sdk/base';
import type { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError, SubmissionRejectedError } from '../errors.js';
import type { MandateActionRequest, SigningRequest } from '../types.js';

import { NETWORK, OPTS, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { failedFeeBumpResult } from './test-results.js';
import { PASSPHRASES } from './tx.js';

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

async function submitted(t: TestSetup) {
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
  return { req, requestId: request.requestId, txHash: ref.txHash };
}

describe('what proves a transaction landed', { timeout: 30_000 }, () => {
  it('simulated events without a getTransaction success are not landed', async () => {
    const t = setup();
    const { req, requestId, txHash } = await submitted(t);
    // Simulated with success and accepted by the node, and still nothing proves it.
    expect(t.rpc.simulated.length).toBeGreaterThan(0);
    t.rpc.txs.set(txHash, { status: 'NOT_FOUND' });
    await expect(t.adapter.signedOutcome(req, requestId, OPTS)).resolves.toEqual({
      status: 'pending',
      txHash,
    });
    expect(t.store.submissions.get(`${NETWORK}:${txHash}`)?.state).toBe('broadcast');
  });

  it('a getTransaction success is landed, and is recorded', async () => {
    const t = setup();
    const { req, requestId, txHash } = await submitted(t);
    t.rpc.txs.set(txHash, { status: 'SUCCESS', ledger: 42 });
    await expect(t.adapter.signedOutcome(req, requestId, OPTS)).resolves.toEqual({
      status: 'landed',
      txHash,
      ledger: 42,
    });
    expect(t.store.submissions.get(`${NETWORK}:${txHash}`)).toMatchObject({
      state: 'landed',
      landedAtHeight: 42n,
    });
  });

  it('a failure that is not about resources is rejected, and did land', async () => {
    const t = setup();
    const { req, requestId, txHash } = await submitted(t);
    t.rpc.txs.set(txHash, { status: 'FAILED', resultXdr: failedFeeBumpResult('trapped') });
    const outcome = t.adapter.signedOutcome(req, requestId, OPTS);
    await expect(outcome).rejects.toBeInstanceOf(SubmissionRejectedError);
    await expect(outcome).rejects.toMatchObject({ landed: 'yes' });
    expect(t.store.submissions.get(`${NETWORK}:${txHash}`)?.state).toBe('failed');
  });

  it('refuses an unknown request, one not yet submitted, and another action', async () => {
    const t = setup();
    const req = requestOf(t);
    await expect(t.adapter.signedOutcome(req, 'nope', OPTS)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    const prepared = await t.adapter.prepareMandateAction(req, OPTS);
    await expect(t.adapter.signedOutcome(req, prepared.requestId, OPTS)).rejects.toMatchObject({
      issues: ['requestId (not_submitted)'],
    });
    const other: MandateActionRequest = { ...req, action: { op: 'resume' } };
    await expect(t.adapter.signedOutcome(other, prepared.requestId, OPTS)).rejects.toMatchObject({
      issues: ['action (mismatch)'],
    });
  });
});
