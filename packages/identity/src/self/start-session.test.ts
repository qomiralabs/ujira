// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { UnixSeconds } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { parseIdentityConfig } from '../config.js';
import {
  CallTimeoutError,
  ProviderUnavailableError,
  SelfCreditsExhaustedError,
  SelfSessionRefusedError,
} from '../errors.js';
import type { IdentityInputError } from '../errors.js';
import { TEST_NOW, identityRow, newId, recipientRow, selfWorld } from '../testing/index.js';
import type { SelfWorld } from '../testing/index.js';

import { SELF_SESSION_TTL_SECONDS } from './config.js';
import { createSelfVerification } from './service.js';

const RETURN_URL = 'https://app.example/back';

function start(w: SelfWorld, recipientId = w.recipient.id) {
  return w.service.startSelfSession(w.ctx, { recipientId, returnUrl: RETURN_URL });
}

describe('startSelfSession', () => {
  it('creates the pending identity row and a session for it, with the fixed flow rules', async () => {
    const w = selfWorld();
    const session = await start(w);
    expect(session).toMatchObject({ reused: false, sessionId: 'sess_1' });
    expect(session.expiresAt).toBe(TEST_NOW + BigInt(SELF_SESSION_TTL_SECONDS));
    expect(w.client.requests).toEqual([
      {
        environment: 'test',
        flowId: 'flow_prekyc',
        flowVersion: '1',
        rules: {
          minimumAge: 18,
          ofac: true,
          excludedCountries: [],
          reveals: [],
          security: 'high',
          mode: 'backend',
        },
        externalUuid: session.identityId,
        returnUrl: RETURN_URL,
        ttlSeconds: 1_800,
      },
    ]);
    expect(await w.store.identityById(session.identityId)).toMatchObject({
      scope: w.scope,
      recipientId: w.recipient.id,
      provider: 'self',
      status: 'pending',
      assurance: 'none',
      pendingSession: { sessionId: 'sess_1', url: session.url, expiresAt: session.expiresAt },
    });
  });

  it('reuses the pending session until it expires, then starts a new one', async () => {
    const w = selfWorld();
    const first = await start(w);
    w.clock.set((first.expiresAt - 1n) as UnixSeconds);
    expect(await start(w)).toEqual({ ...first, reused: true });
    expect(w.client.requests).toHaveLength(1);

    w.clock.set(first.expiresAt);
    const second = await start(w);
    expect(second).toMatchObject({
      reused: false,
      sessionId: 'sess_2',
      identityId: first.identityId,
    });
  });

  it('a rejected or expired verification can start again, on the same row', async () => {
    const w = selfWorld();
    const row = identityRow(w.scope, w.recipient.id, { status: 'rejected', assurance: 'none' });
    w.store.putIdentity(row);
    const session = await start(w);
    expect(session.identityId).toBe(row.id);
    expect((await w.store.identityById(row.id))?.status).toBe('pending');

    const lapsed = selfWorld();
    lapsed.store.putIdentity(
      identityRow(lapsed.scope, lapsed.recipient.id, { expiresAt: TEST_NOW }),
    );
    expect((await start(lapsed)).reused).toBe(false);
  });

  it('refuses an inactive or unknown recipient, an erased identity and a current verification', async () => {
    const w = selfWorld();
    const inactive = recipientRow(w.scope, { status: 'inactive' });
    w.store.putRecipient(inactive);
    const refusals: [Promise<unknown>, string][] = [[start(w, inactive.id), 'recipient_inactive']];
    refusals.push([start(w, newId()), 'recipient_inactive']);

    const erased = selfWorld();
    erased.store.putIdentity(identityRow(erased.scope, erased.recipient.id, { status: 'revoked' }));
    refusals.push([start(erased), 'revoked']);

    const verified = selfWorld();
    verified.store.putIdentity(
      identityRow(verified.scope, verified.recipient.id, {
        expiresAt: (TEST_NOW + 10n) as UnixSeconds,
      }),
    );
    refusals.push([start(verified), 'already_verified']);
    const forever = selfWorld();
    forever.store.putIdentity(identityRow(forever.scope, forever.recipient.id));
    refusals.push([start(forever), 'already_verified']);

    for (const [running, reason] of refusals) {
      const error = await running.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SelfSessionRefusedError);
      expect((error as SelfSessionRefusedError).reason).toBe(reason);
    }
    expect(w.client.requests).toEqual([]);
  });

  it('refuses a malformed request and a return URL that is not https', async () => {
    const w = selfWorld();
    const error = await w.service
      .startSelfSession(w.ctx, { recipientId: w.recipient.id, returnUrl: 'http://app.example' })
      .catch((e: unknown) => e);
    expect((error as IdentityInputError).issues).toEqual(['returnUrl (invalid_format)']);
  });

  it('Self switched off is unavailable, not the recipient fault', async () => {
    const w = selfWorld();
    const service = createSelfVerification({
      ...w.ports,
      config: () => parseIdentityConfig({}),
    });
    await expect(
      service.startSelfSession(w.ctx, { recipientId: w.recipient.id, returnUrl: RETURN_URL }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it('exhausted credits alert operations and surface as unavailable', async () => {
    const w = selfWorld();
    w.client.failure = 'credits_exhausted';
    const error = await start(w).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(SelfCreditsExhaustedError);
    expect(w.alerts.credits).toEqual([{ environment: 'test', correlationId: 'trace-self' }]);
  });

  it('a session call that hangs times out, and other failures pass through', async () => {
    const w = selfWorld();
    const service = createSelfVerification({
      ...w.ports,
      self: { ...w.ports.self, callTimeoutMs: 100 },
    });
    w.client.failure = 'hang';
    await expect(
      service.startSelfSession(w.ctx, { recipientId: w.recipient.id, returnUrl: RETURN_URL }),
    ).rejects.toThrow(CallTimeoutError);

    const boom = new Error('connection reset');
    w.client.failure = boom;
    await expect(start(w)).rejects.toBe(boom);
    expect(w.alerts.credits).toEqual([]);
  });
});

describe('construction', () => {
  it('refuses a key for the wrong deployment and a short nullifier key', () => {
    const w = selfWorld();
    expect(() => createSelfVerification({ ...w.ports, deployment: 'production' })).toThrow(
      /Invalid identity configuration/,
    );
    expect(() =>
      createSelfVerification({
        ...w.ports,
        credentials: { ...w.ports.credentials, nullifierKey: new Uint8Array(16) },
      }),
    ).toThrow(RangeError);
  });
});
