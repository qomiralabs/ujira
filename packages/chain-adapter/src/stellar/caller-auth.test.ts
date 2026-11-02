// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The address a call names as its caller is always the address that signs
// for it. Calls without a caller argument are authorized by the principal
// (or, for accept_principal, the proposed principal), so a wrong signer
// there is a host authorization failure, refused before anyone signs.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError, SubmissionRejectedError } from '../errors.js';
import type { Bytes32, ChainAddress, MandateAction, PayoutId, UnixSeconds } from '../types.js';
import { tokenAmount } from '@ujira/core';
import { NETWORK, OPTS, addAccount, setup } from './test-adapter.js';
import { FIXTURE_FACTORY } from './test-rpc.js';

const at = (value: string): ChainAddress => ({ network: NETWORK, value });
const usdc = (n: bigint) => tokenAmount(n, 'USDC', 'stellar');

// Building and parsing XDR is slow on a loaded machine, so each test gets
// more than the default five seconds.
describe('caller authorization', { timeout: 30_000 }, () => {
  it('caller different from the signing address gives INVALID_INPUT with no simulation', async () => {
    const t = setup();
    const other = Keypair.random().publicKey();
    const ops: MandateAction[] = [
      { op: 'pause' },
      { op: 'cancel', payoutId: `0x${'11'.repeat(32)}` as PayoutId },
      { op: 'cancel_batch', payoutIds: [`0x${'11'.repeat(32)}` as PayoutId] },
      { op: 'sweep' },
      { op: 'recovery_revoke' },
    ];
    for (const action of ops) {
      const refused = t.adapter.prepareMandateAction(
        {
          scope: t.scope,
          mandate: t.mandate,
          action,
          signer: {
            kind: 'external',
            network: NETWORK,
            role: 'principal',
            address: at(t.principal.publicKey()),
          },
          caller: at(other),
        },
        OPTS,
      );
      await expect(refused).rejects.toBeInstanceOf(InvalidInputError);
      await expect(refused).rejects.toMatchObject({ issues: ['caller (not_signer)'] });
    }
    // A caller on another network is not the signer either.
    await expect(
      t.adapter.prepareMandateAction(
        {
          scope: t.scope,
          mandate: t.mandate,
          action: { op: 'pause' },
          signer: {
            kind: 'external',
            network: NETWORK,
            role: 'principal',
            address: at(t.principal.publicKey()),
          },
          caller: { network: 'stellar:pubnet', value: t.principal.publicKey() },
        },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(t.rpc.calls).not.toContain('simulateTransaction');
    expect(t.rpc.simulated).toHaveLength(0);

    // The same caller as the signer is fine.
    const ok = await t.adapter.prepareMandateAction(
      {
        scope: t.scope,
        mandate: t.mandate,
        action: { op: 'pause' },
        signer: {
          kind: 'external',
          network: NETWORK,
          role: 'principal',
          address: at(t.principal.publicKey()),
        },
        caller: at(t.principal.publicKey()),
      },
      OPTS,
    );
    expect(ok.kind).toBe('stellar_transaction');
  });

  it('wrong signer on create gives SUBMISSION_REJECTED', async () => {
    const t = setup();
    const agent = Keypair.random();
    addAccount(t.rpc, agent.publicKey(), 3n);
    const refused = t.adapter.prepareMandateAction(
      {
        scope: t.scope,
        mandate: null,
        action: {
          op: 'create',
          factory: at(FIXTURE_FACTORY),
          salt: `0x${'22'.repeat(32)}` as Bytes32,
          config: {
            principal: at(t.principal.publicKey()),
            asset: 'USDC',
            recipientMode: 'allowlist',
            agents: [at(agent.publicKey())],
            approvers: [],
            approvalsRequired: 0,
            guardians: [],
            executors: [],
            recovery: [],
            recoveryThreshold: 0,
            limits: {
              totalBudget: usdc(10n),
              perPaymentCap: usdc(1n),
              perRecipientDailyCap: usdc(1n),
              approvalThreshold: usdc(0n),
              payoutTtlSeconds: 3600,
              expiresAt: 1_900_000_000n as UnixSeconds,
            },
            attester: null,
            countryPolicyHash: `0x${'00'.repeat(32)}` as Bytes32,
            maxFeeBps: 0,
          },
        },
        signer: {
          kind: 'external',
          network: NETWORK,
          role: 'agent',
          address: at(agent.publicKey()),
        },
      },
      OPTS,
    );
    await expect(refused).rejects.toBeInstanceOf(SubmissionRejectedError);
    await expect(refused).rejects.toMatchObject({ code: 'SUBMISSION_REJECTED', landed: 'no' });
  });

  it('wrong signer on accept_principal gives SUBMISSION_REJECTED', async () => {
    const t = setup();
    t.rpc.options.proposed = Keypair.random().publicKey();
    await expect(
      t.adapter.prepareMandateAction(
        {
          scope: t.scope,
          mandate: t.mandate,
          action: { op: 'accept_principal' },
          signer: {
            kind: 'external',
            network: NETWORK,
            role: 'principal',
            address: at(t.principal.publicKey()),
          },
        },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(SubmissionRejectedError);
  });
});
