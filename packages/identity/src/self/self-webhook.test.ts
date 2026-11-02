// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes } from 'node:crypto';

import type { UnixSeconds } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { IdentityConflictError } from '../errors.js';
import type { IdentityWriteStore } from '../ports.js';
import { TEST_NOW, identityRow, newId, recipientRow, selfWorld } from '../testing/index.js';
import type { SelfWorld } from '../testing/index.js';
import type { IdentityRecord } from '../types.js';

import { SELF_VERIFICATION_VALIDITY_SECONDS } from './config.js';
import { createSelfVerification } from './service.js';
import { SELF_SIGNATURE_HEADER } from './signature.js';

const later = (seconds: bigint): UnixSeconds => (TEST_NOW + seconds) as UnixSeconds;

async function selfRow(w: SelfWorld, recipientId = w.recipient.id): Promise<IdentityRecord> {
  const rows = await w.store.identities(w.scope, recipientId);
  const row = rows.find((r) => r.provider === 'self');
  if (row === undefined) throw new Error('no self row');
  return row;
}

async function started(w: SelfWorld, recipientId = w.recipient.id) {
  return w.service.startSelfSession(w.ctx, { recipientId, returnUrl: 'https://app.example/back' });
}

describe('signatures', () => {
  it('bad signature returns 400', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    const body = w.provider.body({
      externalUuid: identityId,
      status: 'valid',
      completedAt: TEST_NOW,
    });
    const forged = w.provider.sign(body, TEST_NOW, { secret: randomBytes(32) });
    expect(await w.webhook(forged)).toEqual({
      status: 400,
      body: { code: 'WEBHOOK_SIGNATURE_INVALID' },
    });

    // Signed correctly, then one byte of the body changed.
    const good = w.provider.sign(body, TEST_NOW);
    const tampered = Uint8Array.from(good.rawBody);
    tampered[tampered.length - 2] = 0x20;
    expect((await w.webhook({ ...good, rawBody: tampered })).status).toBe(400);

    // No header, a header in the wrong form, and a stale signed time.
    expect((await w.webhook({ rawBody: good.rawBody, headers: {} })).status).toBe(400);
    expect(
      (await w.webhook({ rawBody: good.rawBody, headers: { [SELF_SIGNATURE_HEADER]: 'v1=zz' } }))
        .status,
    ).toBe(400);
    expect((await w.webhook(w.provider.sign(body, later(-301n)))).status).toBe(400);
    expect((await selfRow(w)).status).toBe('pending');
    expect(w.events.all()).toEqual([]);
  });

  it('a delivery within the tolerance either way is accepted', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    const body = w.provider.body({
      externalUuid: identityId,
      status: 'valid',
      completedAt: TEST_NOW,
    });
    expect(await w.webhook(w.provider.sign(body, later(300n)))).toEqual({
      status: 200,
      body: { result: 'applied' },
    });
  });

  it('a body that is not JSON or not the schema is refused, even when signed', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    expect(await w.webhook(w.provider.sign(null, TEST_NOW, { raw: '{not json' }))).toEqual({
      status: 400,
      body: { code: 'WEBHOOK_PAYLOAD_INVALID' },
    });
    const noNullifier = w.provider.body({
      externalUuid: identityId,
      status: 'valid',
      nullifier: null,
      completedAt: TEST_NOW,
    });
    expect((await w.webhook(w.provider.sign(noNullifier, TEST_NOW))).body).toEqual({
      code: 'WEBHOOK_PAYLOAD_INVALID',
    });
    expect((await w.webhook(w.provider.sign({ type: 'other' }, TEST_NOW))).status).toBe(400);
  });
});

describe('recorded outcomes', () => {
  it('valid: verified at document_zk for 365 days, session cleared', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    const completedAt = later(-10n);
    expect(
      await w.webhook(
        w.provider.deliver({ externalUuid: identityId, status: 'valid', completedAt }, TEST_NOW),
      ),
    ).toEqual({ status: 200, body: { result: 'applied' } });
    expect(await selfRow(w)).toMatchObject({
      status: 'verified',
      assurance: 'document_zk',
      expiresAt: completedAt + SELF_VERIFICATION_VALIDITY_SECONDS,
      providerStatus: 'valid',
      pendingSession: null,
      failureReason: null,
      lastCheckedAt: completedAt,
    });
    // Eligibility now passes on the wallet rail.
    expect(await w.eligibility()).toMatchObject({ eligible: true, assurance: 'document_zk' });
  });

  it('invalid: rejected', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    await w.webhook(
      w.provider.deliver({ externalUuid: identityId, status: 'invalid', completedAt: TEST_NOW }),
    );
    expect(await selfRow(w)).toMatchObject({ status: 'rejected', failureReason: 'invalid' });
    expect(await w.eligibility()).toEqual({ eligible: false, reason: 'IDENTITY_REJECTED' });
  });

  it('error: stays pending so the recipient can try again', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    await w.webhook(
      w.provider.deliver({ externalUuid: identityId, status: 'error', completedAt: TEST_NOW }),
    );
    expect(await selfRow(w)).toMatchObject({
      status: 'pending',
      failureReason: 'provider_error',
      pendingSession: null,
    });
    expect(w.alerts.credits).toEqual([]);
  });

  it('error with exhausted credits alerts operations and is not the recipient fault', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    await w.webhook(
      w.provider.deliver({
        externalUuid: identityId,
        status: 'error',
        errorCode: 'SELF_CREDITS_EXHAUSTED',
        completedAt: TEST_NOW,
      }),
    );
    expect(await selfRow(w)).toMatchObject({
      status: 'pending',
      failureReason: 'provider_unavailable',
    });
    expect(w.alerts.credits).toEqual([{ environment: 'test', correlationId: 'trace-webhook' }]);
  });

  it('expired: the session lapsed, the row stays pending', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    await w.webhook(
      w.provider.deliver({ externalUuid: identityId, status: 'expired', completedAt: TEST_NOW }),
    );
    expect(await selfRow(w)).toMatchObject({ status: 'pending', failureReason: 'session_expired' });
  });

  it('duplicate: the same verification delivered twice is applied once', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    const body = w.provider.body({
      externalUuid: identityId,
      status: 'valid',
      completedAt: TEST_NOW,
    });
    expect((await w.webhook(w.provider.sign(body, TEST_NOW))).body).toEqual({ result: 'applied' });
    const first = await selfRow(w);
    // A replay with a fresh signature still carries the same verification id.
    expect((await w.webhook(w.provider.sign(body, later(5n)))).body).toEqual({
      result: 'duplicate',
    });
    expect(await selfRow(w)).toEqual(first);
    expect(w.events.all()).toHaveLength(1);
    expect(w.events.all()[0]).toMatchObject({
      provider: 'self',
      providerAccount: 'test:flow_prekyc',
      eventKey: `${String(body['verification_id'])}-completed`,
    });
  });

  it('out of order: an older result, or a lapsed session after a result, changes nothing', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    await w.webhook(
      w.provider.deliver({ externalUuid: identityId, status: 'valid', completedAt: TEST_NOW }),
    );
    const verified = await selfRow(w);

    const older = w.provider.deliver(
      { externalUuid: identityId, status: 'invalid', completedAt: later(-60n) },
      TEST_NOW,
    );
    expect((await w.webhook(older)).body).toEqual({ result: 'stale' });
    const lapsed = w.provider.deliver(
      { externalUuid: identityId, status: 'expired', completedAt: later(60n) },
      TEST_NOW,
    );
    expect((await w.webhook(lapsed)).body).toEqual({ result: 'stale' });
    const errored = w.provider.deliver(
      { externalUuid: identityId, status: 'error', completedAt: later(61n) },
      TEST_NOW,
    );
    expect((await w.webhook(errored)).body).toEqual({ result: 'stale' });
    expect(await selfRow(w)).toEqual(verified);
    // Each was still recorded, so a retry of any of them is a duplicate.
    expect(w.events.all()).toHaveLength(4);
  });

  it('a newer final result replaces an older one', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    await w.webhook(
      w.provider.deliver({ externalUuid: identityId, status: 'invalid', completedAt: TEST_NOW }),
    );
    await w.webhook(
      w.provider.deliver(
        { externalUuid: identityId, status: 'valid', completedAt: later(30n) },
        later(30n),
      ),
    );
    expect((await selfRow(w)).status).toBe('verified');
  });

  it('an unknown, erased or other provider row takes nothing from the event', async () => {
    const w = selfWorld();
    expect(
      (
        await w.webhook(
          w.provider.deliver({ externalUuid: newId(), status: 'valid', completedAt: TEST_NOW }),
        )
      ).body,
    ).toEqual({ result: 'ignored' });

    const { identityId } = await started(w);
    await w.store.updateIdentity(w.scope, identityId, { status: 'revoked' });
    expect(
      (
        await w.webhook(
          w.provider.deliver({ externalUuid: identityId, status: 'valid', completedAt: TEST_NOW }),
        )
      ).body,
    ).toEqual({ result: 'ignored' });
    expect((await selfRow(w)).status).toBe('revoked');

    const anchorRow = identityRow(w.scope, w.recipient.id, {
      provider: 'sep12',
      providerAccount: 'a',
    });
    w.store.putIdentity(anchorRow);
    expect(
      (
        await w.webhook(
          w.provider.deliver({
            externalUuid: anchorRow.id,
            status: 'valid',
            completedAt: TEST_NOW,
          }),
        )
      ).body,
    ).toEqual({ result: 'ignored' });
  });
});

describe('nothing personal is stored', () => {
  it('stored row has only the allowed fields', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    const nullifier = 'nullifier-of-a-real-person';
    const delivery = w.provider.deliver({
      externalUuid: identityId,
      status: 'valid',
      nullifier,
      completedAt: TEST_NOW,
    });
    await w.webhook(delivery);
    const row = await selfRow(w);
    expect(Object.keys(row).sort()).toEqual(
      [
        'scope',
        'id',
        'recipientId',
        'provider',
        'providerAccount',
        'status',
        'assurance',
        'expiresAt',
        'providerRef',
        'providerStatus',
        'flowRef',
        'nullifierHmac',
        'pendingSession',
        'failureReason',
        'rawSha256',
        'lastCheckedAt',
      ].sort(),
    );
    const stored = JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const marker of [nullifier, 'PROOF-MARKER', 'CONTEXT-MARKER', 'publicSignals']) {
      expect(stored).not.toContain(marker);
    }
    expect(row.nullifierHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    const events = JSON.stringify(w.events.all(), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(events).not.toContain(nullifier);
    expect(events).not.toContain('PROOF-MARKER');
  });
});

describe('duplicate people', () => {
  it('same nullifier for two recipients gives duplicate_person', async () => {
    const w = selfWorld();
    const second = recipientRow(w.scope);
    w.store.putRecipient(second);
    const first = await started(w);
    const other = await started(w, second.id);
    const nullifier = 'same-person';
    await w.webhook(
      w.provider.deliver({
        externalUuid: first.identityId,
        status: 'valid',
        nullifier,
        completedAt: TEST_NOW,
      }),
    );
    await w.webhook(
      w.provider.deliver({
        externalUuid: other.identityId,
        status: 'valid',
        nullifier,
        completedAt: TEST_NOW,
      }),
    );

    expect((await selfRow(w)).status).toBe('verified');
    expect(await selfRow(w, second.id)).toMatchObject({
      status: 'rejected',
      failureReason: 'duplicate_person',
    });
    expect(w.alerts.duplicates).toEqual([
      { scope: w.scope, recipientId: second.id, existingRecipientId: w.recipient.id },
    ]);
  });

  it('the same person under another principal is not a duplicate', async () => {
    const a = selfWorld();
    const b = selfWorld({ nullifierKey: a.nullifierKey, store: a.store, provider: a.provider });
    const one = await started(a);
    const two = await started(b);
    const nullifier = 'same-person';
    await a.webhook(
      a.provider.deliver({
        externalUuid: one.identityId,
        status: 'valid',
        nullifier,
        completedAt: TEST_NOW,
      }),
    );
    await b.webhook(
      b.provider.deliver({
        externalUuid: two.identityId,
        status: 'valid',
        nullifier,
        completedAt: TEST_NOW,
      }),
    );
    expect((await selfRow(b)).status).toBe('verified');
    expect(b.alerts.duplicates).toEqual([]);
  });

  it('a duplicate caught by the store, after the check passed, is recorded the same way', async () => {
    const w = selfWorld();
    const second = recipientRow(w.scope);
    w.store.putRecipient(second);
    const first = await started(w);
    const other = await started(w, second.id);
    const nullifier = 'racing-person';
    // The check sees nobody yet; the write then hits the unique rule.
    let hidden = true;
    const racing: IdentityWriteStore = {
      identityById: (id) => w.store.identityById(id),
      createIdentity: (row) => w.store.createIdentity(row),
      updateIdentity: (scope, id, patch) => w.store.updateIdentity(scope, id, patch),
      verifiedByNullifier: async (principalId, hmac) =>
        hidden ? null : w.store.verifiedByNullifier(principalId, hmac),
    };
    const service = createSelfVerification({
      ...w.ports,
      store: Object.assign(Object.create(w.store) as typeof w.store, racing),
    });
    await w.webhook(
      w.provider.deliver({
        externalUuid: first.identityId,
        status: 'valid',
        nullifier,
        completedAt: TEST_NOW,
      }),
    );
    const response = await service.handleWebhook({
      ...w.provider.deliver({
        externalUuid: other.identityId,
        status: 'valid',
        nullifier,
        completedAt: TEST_NOW,
      }),
      correlationId: 'trace-race',
    });
    hidden = false;
    expect(response.body).toEqual({ result: 'applied' });
    expect(await selfRow(w, second.id)).toMatchObject({
      status: 'rejected',
      failureReason: 'duplicate_person',
      assurance: 'none',
    });
    expect(w.alerts.duplicates).toHaveLength(1);
  });

  it('the store refuses a second verified row with the same nullifier', async () => {
    const w = selfWorld();
    const hmac = 'a'.repeat(64);
    const one = identityRow(w.scope, w.recipient.id, { status: 'verified', nullifierHmac: hmac });
    const two = identityRow(w.scope, newId(), { status: 'pending' });
    w.store.putIdentity(one).putIdentity(two);
    await expect(
      w.store.updateIdentity(w.scope, two.id, { status: 'verified', nullifierHmac: hmac }),
    ).rejects.toThrow(IdentityConflictError);
  });
});

describe('environment and flow', () => {
  it('a live event in test is refused', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    const live = w.provider.deliver({
      externalUuid: identityId,
      status: 'valid',
      environment: 'live',
      completedAt: TEST_NOW,
    });
    expect(await w.webhook(live)).toEqual({ status: 400, body: { code: 'WEBHOOK_REJECTED' } });
    expect((await selfRow(w)).status).toBe('pending');
  });

  it('a different flow id is refused', async () => {
    const w = selfWorld();
    const { identityId } = await started(w);
    const other = w.provider.deliver({
      externalUuid: identityId,
      status: 'valid',
      flowId: 'flow_other',
      completedAt: TEST_NOW,
    });
    expect(await w.webhook(other)).toEqual({ status: 400, body: { code: 'WEBHOOK_REJECTED' } });
    expect(w.events.all()).toEqual([]);
  });
});
