// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The real Stellar adapter against the real signer policies. Each side has its own
// tests with its own idea of the other, and that is how the adapter came to send
// payloads the signer refuses, in production and in no test. Here the adapter's own
// output meets the policy, with the real sponsorship policy writing the ledger the
// signer reads.

import type {
  CallOptions,
  SignerRef,
  SponsoredIntent,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { createSponsorshipPolicy, reservationIdOf } from '@ujira/chain-adapter';
import { createMemorySponsorshipLedger } from '@ujira/chain-adapter/testing';
import {
  NETWORK,
  OPTS,
  authEntryFor,
  entryHash,
  footprintXdr,
  payRequest,
  payWorld,
  record,
  relayedCallXdr,
  signedBy,
  sourceAccountEntry,
  withWalletSignature,
} from '@ujira/chain-adapter/testing/stellar';
import type { PayWorld } from '@ujira/chain-adapter/testing/stellar';
import { describe, expect, it } from 'vitest';

import { agentPolicy } from './agent-policy.js';
import { SIGNED_CALL_INTENTS, chainPolicy } from './chain-policy.js';
import { memoryManagedSignerStore, memoryMandateIndex, memoryRateLimiter } from './memory.js';
import { sponsorshipsFromLedger } from './sponsorships.js';

type Entry = ReturnType<typeof authEntryFor>;

const AGENT_ID = '00000000-0000-4000-8000-0000000000bb' as Uuid;
const WALLET = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const OTHER_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const FEE_CAP = 100_000_000n;
const NOW = 1_793_500_000n as UnixSeconds;

function world() {
  const ledger = createMemorySponsorshipLedger();
  const asked: { kind: string; ref: SignerRef['kind'] }[] = [];
  let chain: ReturnType<typeof chainPolicy> | undefined;
  const w = payWorld({
    sponsorship: (t) =>
      createSponsorshipPolicy({
        ledger,
        config: t.ports.config,
        clock: { nowSeconds: () => NOW },
        alerts: { lowBalance: () => undefined },
        sponsorBalance: () => Promise.resolve(10n ** 13n),
      }),
    wrapSigner: (inner, agent, t) => {
      const mandates = memoryMandateIndex([
        {
          network: NETWORK,
          contract: t.mandate.address.value,
          tenant: t.scope,
          recipientMode: 'allowlist',
          executors: [t.channel.publicKey()],
        },
      ]);
      chain = chainPolicy({
        networks: {
          [NETWORK]: {
            executorMaxFeeStroops: FEE_CAP,
            sponsorMaxFeeStroops: FEE_CAP,
            payoutAsset: { code: 'USDC', issuer: 'unused' },
            sep10: {},
          },
        },
        mandates,
        sponsorships: sponsorshipsFromLedger(ledger),
      });
      const agents = agentPolicy({
        signers: memoryManagedSignerStore([
          {
            network: NETWORK,
            scope: t.scope,
            agentId: AGENT_ID,
            address: agent.publicKey(),
            keyRef: 'agent-key',
            keyTags: t.scope,
          },
        ]),
        mandates,
        rateLimiter: memoryRateLimiter({ limit: 100, windowSeconds: 60n }),
      });
      return {
        ...inner,
        sign: async (ref, payload, opts) => {
          asked.push({ kind: payload.kind, ref: ref.kind });
          const policy = ref.kind === 'managed_agent' ? agents : chain;
          if (policy === undefined) throw new Error('no policy');
          await policy.check(ref, payload, { caller: 'test', now: NOW, opts });
          return inner.sign(ref, payload, opts);
        },
      };
    },
  });
  const policy = () => {
    if (chain === undefined) throw new Error('no policy');
    return chain;
  };
  return { w, ledger, asked, policy };
}

function externalSigner(value: string) {
  return {
    kind: 'external',
    network: NETWORK,
    role: 'principal',
    address: { network: NETWORK, value },
  } as never;
}

describe('the adapter against the real signer policies', { timeout: 60_000 }, () => {
  it('a G principal: its own transaction, in the sponsor fee bump', async () => {
    const { w, asked } = world();
    const request = await w.payouts.prepareMandateAction(
      {
        scope: w.scope,
        mandate: w.mandate,
        action: { op: 'pause' },
        signer: externalSigner(w.principal.publicKey()),
      },
      OPTS,
    );
    if (request.kind !== 'stellar_transaction') throw new Error('expected a transaction');
    await w.payouts.submitSigned(
      {
        scope: w.scope,
        requestId: request.requestId,
        signed: signedBy(request.xdr, w.principal),
        correlationId: 'c',
      },
      OPTS,
    );
    expect(asked).toEqual([{ kind: 'stellar_fee_bump', ref: 'fee_sponsor' }]);
    expect(w.rpc.sent).toHaveLength(1);
  });

  it('a C principal: its signed entry, carried by a channel account', async () => {
    const { w, asked } = world();
    const request = await w.payouts.prepareMandateAction(
      {
        scope: w.scope,
        mandate: w.mandate,
        action: { op: 'pause' },
        signer: externalSigner(WALLET),
      },
      OPTS,
    );
    if (request.kind !== 'stellar_auth_entry') throw new Error('expected an entry');
    await w.payouts.submitSigned(
      {
        scope: w.scope,
        requestId: request.requestId,
        signed: withWalletSignature(request.entryXdr),
        correlationId: 'c',
      },
      OPTS,
    );
    expect(asked).toEqual([{ kind: 'stellar_relayed_call', ref: 'executor' }]);
    expect(w.rpc.sent).toHaveLength(1);
  });

  it('a managed agent: its own transaction, in the sponsor fee bump', async () => {
    const { w, asked } = world();
    await w.payouts.pay(
      payRequest(w, 1, {
        signer: { kind: 'managed_agent', network: NETWORK, scope: w.scope, agentId: AGENT_ID },
      }),
      OPTS,
    );
    expect(asked).toEqual([
      { kind: 'stellar_tx', ref: 'managed_agent' },
      { kind: 'stellar_fee_bump', ref: 'fee_sponsor' },
    ]);
    expect(w.rpc.sent).toHaveLength(1);
  });

  it('an executor: an execute, from a channel account', async () => {
    const { w, asked } = world();
    const req = payRequest(w);
    w.views.set(req.payoutId, record(2));
    await w.payouts.pay(req, OPTS);
    expect(asked).toEqual([{ kind: 'stellar_tx', ref: 'executor' }]);
    expect(w.rpc.sent).toHaveLength(1);
  });
});

describe('what stays refused', { timeout: 60_000 }, () => {
  const executor: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'channel-1' };
  const context = (opts: CallOptions = OPTS) => ({ caller: 'test', now: NOW, opts });
  const relayed = (xdr: string) =>
    ({ kind: 'stellar_relayed_call', network: NETWORK, xdr }) as const;
  const denied = { code: 'SIGNER_DENIED' };

  async function reserve(
    { w, ledger }: Pick<ReturnType<typeof world>, 'w' | 'ledger'>,
    entry: Entry,
    intent: SponsoredIntent = 'pause',
    state: 'reserved' | 'settled' = 'reserved',
  ) {
    await ledger.insert({
      reservationId: reservationIdOf(NETWORK, entryHash(entry)),
      scope: w.scope,
      network: NETWORK,
      intent,
      state,
      maxFeeStroops: FEE_CAP,
      actualFeeStroops: null,
      rentStroops: null,
      reservedAt: NOW,
      activation: null,
    });
  }

  it('accepts the one shape it allows, which is what gives the refusals below their meaning', async () => {
    const t = world();
    const entry = authEntryFor(WALLET, t.w.mandate.address.value, 'pause');
    await reserve(t, entry);
    await expect(
      t.policy().check(executor, relayed(relayedCallXdr(t.w, [entry])), context()),
    ).resolves.toMatchObject({ tenant: t.w.scope });
  });

  it('an executor still cannot sign a stellar_tx for anything but an execute', async () => {
    const t = world();
    const entry = authEntryFor(WALLET, t.w.mandate.address.value, 'pause');
    await reserve(t, entry);
    await expect(
      t
        .policy()
        .check(
          executor,
          { kind: 'stellar_tx', network: NETWORK, xdr: relayedCallXdr(t.w, [entry]) },
          context(),
        ),
    ).rejects.toMatchObject(denied);
  });

  it('the fee sponsor cannot carry a relayed call', async () => {
    const t = world();
    const entry = authEntryFor(WALLET, t.w.mandate.address.value, 'pause');
    await reserve(t, entry);
    await expect(
      t
        .policy()
        .check(
          { kind: 'fee_sponsor', network: NETWORK },
          relayed(relayedCallXdr(t.w, [entry])),
          context(),
        ),
    ).rejects.toMatchObject(denied);
  });

  it.each<[string, (w: PayWorld) => Entry[], { contract?: string; fn?: string }]>([
    ['no entry', () => [], {}],
    [
      'an unsigned entry',
      (w) => [authEntryFor(WALLET, w.mandate.address.value, 'pause', false)],
      {},
    ],
    [
      'an entry that is the channel itself',
      (w) => [authEntryFor(w.channel.publicKey(), w.mandate.address.value, 'pause')],
      {},
    ],
    [
      'two entries',
      (w) => [
        authEntryFor(WALLET, w.mandate.address.value, 'pause'),
        authEntryFor(WALLET, w.mandate.address.value, 'pause'),
      ],
      {},
    ],
    [
      'an entry for another function',
      (w) => [authEntryFor(WALLET, w.mandate.address.value, 'withdraw')],
      {},
    ],
    ['an entry for another contract', () => [authEntryFor(WALLET, OTHER_CONTRACT, 'pause')], {}],
    [
      'a contract neither a mandate nor a relay token',
      () => [authEntryFor(WALLET, OTHER_CONTRACT, 'pause')],
      { contract: OTHER_CONTRACT },
    ],
  ])('refuses %s', async (_name, entries, over) => {
    const t = world();
    const auth = entries(t.w);
    const [first] = auth;
    // A reservation for it, so the refusal is about the shape and nothing else.
    if (first !== undefined) await reserve(t, first);
    await expect(
      t.policy().check(executor, relayed(relayedCallXdr(t.w, auth, over)), context()),
    ).rejects.toMatchObject(denied);
  });

  it('allows a relay token only where the network names one', async () => {
    const t = world();
    const entry = authEntryFor(WALLET, OTHER_CONTRACT, 'transfer');
    await reserve(t, entry);
    const payload = relayed(
      relayedCallXdr(t.w, [entry], { contract: OTHER_CONTRACT, fn: 'transfer' }),
    );
    await expect(t.policy().check(executor, payload, context())).rejects.toMatchObject(denied);
    const withToken = chainPolicy({
      networks: {
        [NETWORK]: {
          executorMaxFeeStroops: FEE_CAP,
          sponsorMaxFeeStroops: FEE_CAP,
          payoutAsset: { code: 'USDC', issuer: 'unused' },
          sep10: {},
          relayTokens: [OTHER_CONTRACT],
        },
      },
      mandates: memoryMandateIndex([]),
      sponsorships: sponsorshipsFromLedger(t.ledger),
    });
    await expect(withToken.check(executor, payload, context())).resolves.toMatchObject({
      tenant: t.w.scope,
    });
  });

  it('refuses a mandate of another tenant than the reservation', async () => {
    const t = world();
    const entry = authEntryFor(WALLET, t.w.mandate.address.value, 'pause');
    await t.ledger.insert({
      reservationId: reservationIdOf(NETWORK, entryHash(entry)),
      scope: { ...t.w.scope, projectId: '00000000-0000-4000-8000-000000000099' as Uuid },
      network: NETWORK,
      intent: 'pause',
      state: 'reserved',
      maxFeeStroops: FEE_CAP,
      actualFeeStroops: null,
      rentStroops: null,
      reservedAt: NOW,
      activation: null,
    });
    await expect(
      t.policy().check(executor, relayed(relayedCallXdr(t.w, [entry])), context()),
    ).rejects.toMatchObject(denied);
  });

  it('refuses a fee above the cap', async () => {
    const t = world();
    const entry = authEntryFor(WALLET, t.w.mandate.address.value, 'pause');
    await reserve(t, entry);
    await expect(
      t
        .policy()
        .check(
          executor,
          relayed(relayedCallXdr(t.w, [entry], { resourceFee: FEE_CAP + 1n })),
          context(),
        ),
    ).rejects.toMatchObject(denied);
  });

  it('refuses source account credentials, which would let the call spend as the channel', async () => {
    const t = world();
    const entry = sourceAccountEntry(authEntryFor(WALLET, t.w.mandate.address.value, 'pause'));
    await reserve(t, entry);
    await expect(
      t.policy().check(executor, relayed(relayedCallXdr(t.w, [entry])), context()),
    ).rejects.toMatchObject(denied);
  });

  it('refuses with no reservation, and with one already spent', async () => {
    const t = world();
    const entry = authEntryFor(WALLET, t.w.mandate.address.value, 'pause');
    const payload = relayed(relayedCallXdr(t.w, [entry]));
    await expect(t.policy().check(executor, payload, context())).rejects.toMatchObject(denied);
    await reserve(t, entry, 'pause', 'settled');
    await expect(t.policy().check(executor, payload, context())).rejects.toMatchObject(denied);
  });

  it.each<SponsoredIntent>(['executor', 'recipient_activation', 'create_funding_account'])(
    'refuses a reservation under %s, which is no signed call',
    async (intent) => {
      const t = world();
      const entry = authEntryFor(WALLET, t.w.mandate.address.value, 'pause');
      await reserve(t, entry, intent);
      await expect(
        t.policy().check(executor, relayed(relayedCallXdr(t.w, [entry])), context()),
      ).rejects.toMatchObject(denied);
    },
  );

  it('accepts every intent the adapter reserves a signed call under', () => {
    for (const intent of [
      'create_mandate',
      'pause',
      'resume',
      'revoke',
      'approve',
      'reject',
      'cancel',
      'withdraw',
      'admin',
      'fund',
    ] as const) {
      expect(SIGNED_CALL_INTENTS.has(intent), intent).toBe(true);
    }
  });

  describe('restoring and extending', () => {
    const footprint = (xdr: string) =>
      ({ kind: 'stellar_footprint', network: NETWORK, xdr }) as const;

    it('allows a restore and an extension, under their own kind only', async () => {
      const t = world();
      const restore = footprintXdr(t.w, 'restore');
      await expect(t.policy().check(executor, footprint(restore), context())).resolves.toEqual({
        tenant: null,
      });
      const extend = footprintXdr(t.w, 'extend');
      await expect(t.policy().check(executor, footprint(extend), context())).resolves.toEqual({
        tenant: null,
      });
      await expect(
        t
          .policy()
          .check(executor, { kind: 'stellar_tx', network: NETWORK, xdr: restore }, context()),
      ).rejects.toMatchObject(denied);
    });

    it('refuses a contract call under that kind', async () => {
      const t = world();
      await expect(
        t.policy().check(executor, footprint(relayedCallXdr(t.w, [])), context()),
      ).rejects.toMatchObject(denied);
    });

    it('refuses a fee above the cap', async () => {
      const t = world();
      await expect(
        t
          .policy()
          .check(executor, footprint(footprintXdr(t.w, 'restore', FEE_CAP + 1n)), context()),
      ).rejects.toMatchObject(denied);
    });
  });
});
