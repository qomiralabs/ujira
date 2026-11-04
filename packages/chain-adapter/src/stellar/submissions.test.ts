// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { TransactionBuilder } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { RpcTimeoutError } from '../errors.js';
import {
  SUBMISSION_TRANSITIONS,
  canMoveSubmission,
  isLiveSubmission,
} from '../submission-states.js';
import { FakeAdapterStore } from '../testing/fake-store.js';
import type { SigningRequest, SubmissionState, UnixSeconds } from '../types.js';
import { StellarMandateAdapter } from './mandate-adapter.js';
import { NETWORK, OPTS, setup } from './test-adapter.js';
import type { TestSetup } from './test-adapter.js';
import { PASSPHRASES } from './tx.js';

const ALL = Object.keys(SUBMISSION_TRANSITIONS) as SubmissionState[];

// The real adapter on the store that enforces what the database enforces.
function world() {
  const t: TestSetup = setup();
  const store = new FakeAdapterStore({ clock: () => t.clock.now as UnixSeconds });
  const adapter = new StellarMandateAdapter({
    network: NETWORK,
    rpc: t.rpc,
    ports: { ...t.ports, store },
    requests: t.requests,
    wait: { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() },
    submitTimeoutMs: 1000,
  });
  return { t, store, adapter };
}

async function pause({ t, adapter }: ReturnType<typeof world>) {
  const request: SigningRequest = await adapter.prepareMandateAction(
    {
      scope: t.scope,
      mandate: t.mandate,
      action: { op: 'pause' },
      signer: {
        kind: 'external',
        network: NETWORK,
        role: 'principal',
        address: { network: NETWORK, value: t.principal.publicKey() },
      },
    },
    OPTS,
  );
  if (request.kind !== 'stellar_transaction') throw new Error('expected a transaction');
  const tx = TransactionBuilder.fromXdr(request.xdr, PASSPHRASES[NETWORK]);
  tx.sign(t.principal);
  return adapter.submitSigned(
    { scope: t.scope, requestId: request.requestId, signed: tx.toXdr(), correlationId: 'c' },
    OPTS,
  );
}

function assertForward(store: FakeAdapterStore): void {
  expect(store.moves.length).toBeGreaterThan(0);
  for (const { from, to } of store.moves) {
    if (from === null) expect(to).toBe('built');
    else expect(canMoveSubmission(from, to), `${from} to ${to}`).toBe(true);
  }
}

describe('submission states', { timeout: 30_000 }, () => {
  it('state moves follow the forward-only rules', () => {
    const allowed = ALL.flatMap((from) =>
      ALL.filter((to) => canMoveSubmission(from, to)).map((to) => `${from}>${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'built>broadcast',
        'broadcast>landed',
        'broadcast>failed',
        'broadcast>unknown',
        'broadcast>expired',
        'broadcast>replaced',
        'unknown>landed',
        'unknown>failed',
        'unknown>expired',
      ].sort(),
    );
    expect(ALL.filter((s) => isLiveSubmission(s)).sort()).toEqual([
      'broadcast',
      'built',
      'unknown',
    ]);
  });

  it('a send that is accepted goes built then broadcast, before the send and not after', async () => {
    const w = world();
    let stateAtSend: SubmissionState | undefined;
    w.t.rpc.sendResult = (envelope) => {
      stateAtSend = w.store.submissions[0]?.state;
      return {
        status: 'PENDING',
        hash: Buffer.from(
          TransactionBuilder.fromXdr(envelope, PASSPHRASES[NETWORK]).hash(),
        ).toString('hex'),
      };
    };
    await pause(w);
    // A crash during the send leaves a record that says it may have left.
    expect(stateAtSend).toBe('broadcast');
    assertForward(w.store);
    expect(w.store.moves.map((m) => m.to)).toEqual(['built', 'broadcast']);
  });

  it('a refused send moves forward to failed', async () => {
    const w = world();
    w.t.rpc.sendResult = () => ({ status: 'ERROR', hash: 'x' });
    await expect(pause(w)).rejects.toMatchObject({ code: 'SUBMISSION_REJECTED' });
    assertForward(w.store);
    expect(w.store.submissions[0]?.state).toBe('failed');
  });

  it('a send with no answer moves forward to unknown, and the error is the real one', async () => {
    const w = world();
    w.t.rpc.sendResult = () => {
      throw new RpcTimeoutError({ network: NETWORK });
    };
    await expect(pause(w)).rejects.toBeInstanceOf(RpcTimeoutError);
    assertForward(w.store);
    expect(w.store.submissions[0]?.state).toBe('unknown');
  });

  it('records the ledger before the send, and the reservation it spends', async () => {
    const w = world();
    w.t.rpc.latest = { sequence: 4242, closeTime: 1n };
    await pause(w);
    expect(w.store.submissions[0]).toMatchObject({ submittedAtLedger: 4242n });
    expect(w.store.submissions[0]?.reservationId).toMatch(/^[0-9a-f]{64}$/);
  });
});
