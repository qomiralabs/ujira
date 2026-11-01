// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { NetworkId, TenantScope, UnixSeconds } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { parseIdentityConfig } from './config.js';
import type { IdentityConfig } from './config.js';
import { IdentityConfigError, IdentityInputError, IdentityTenantMismatchError } from './errors.js';
import type { IdentityStore } from './ports.js';
import { createIdentityService } from './service.js';
import {
  ANCHOR_RAIL,
  InMemoryIdentityStore,
  ManualClock,
  StaticRailCatalog,
  TEST_NETWORK,
  TEST_NOW,
  WALLET_RAIL,
  identityRow,
  mandateRow,
  methodRow,
  newId,
  newScope,
  railCapability,
  recipientRow,
} from './testing/index.js';
import type {
  Assurance,
  EligibilityRequest,
  IdentityProviderName,
  IdentityRecord,
  RecipientMode,
  RecipientRequirement,
} from './types.js';

const ANCHOR = 'anchor-one';
const OTHER_NETWORK: NetworkId = 'stellar:pubnet';
const ALL_ON = {
  providers: { self: { enabled: true }, sep12: { enabled: true }, principal: { enabled: true } },
};

interface WorldOptions {
  readonly mode?: RecipientMode;
  /** undefined stores no settings, so the default applies. */
  readonly setting?: RecipientRequirement | undefined;
  readonly kycRail?: boolean;
  readonly config?: unknown;
}

function world(options: WorldOptions = {}) {
  const scope = newScope();
  const store = new InMemoryIdentityStore();
  const rails = new StaticRailCatalog()
    .put(TEST_NETWORK, railCapability(WALLET_RAIL))
    .put(TEST_NETWORK, railCapability(ANCHOR_RAIL, { requiresRecipientKyc: true }));
  const clock = new ManualClock();
  let config: IdentityConfig = parseIdentityConfig(options.config ?? ALL_ON);
  const instance = mandateRow(scope, { recipientMode: options.mode ?? 'attested' });
  const recipient = recipientRow(scope);
  const method = methodRow(
    scope,
    recipient.id,
    options.kycRail === true ? { rail: ANCHOR_RAIL, anchorId: ANCHOR } : {},
  );
  store.putMandateInstance(instance).putRecipient(recipient).putPayoutMethod(method);
  if (options.setting !== undefined) {
    store.putProjectSettings(scope, { recipientRequirement: options.setting });
  }
  const service = createIdentityService({ store, rails, clock, config: () => config });
  const request: EligibilityRequest = {
    recipientId: recipient.id,
    methodId: method.id,
    mandateInstanceId: instance.id,
  };
  const ctx = { scope, correlationId: 'trace-1' };
  return {
    scope,
    store,
    rails,
    clock,
    instance,
    recipient,
    method,
    service,
    request,
    ctx,
    setConfig(raw: unknown) {
      config = parseIdentityConfig(raw);
    },
    hold(provider: IdentityProviderName, patch: Partial<IdentityRecord> = {}) {
      store.putIdentity(identityRow(scope, recipient.id, { ...VERIFIED[provider], ...patch }));
    },
    check() {
      return service.eligibility(ctx, request);
    },
  };
}

const VERIFIED: Readonly<Record<IdentityProviderName, Partial<IdentityRecord>>> = {
  self: { provider: 'self', providerAccount: null, assurance: 'document_zk' },
  principal: { provider: 'principal', providerAccount: null, assurance: 'principal_kyc' },
  sep12: { provider: 'sep12', providerAccount: ANCHOR, assurance: 'anchor_kyc' },
};

// Every rail requirement against every project setting under every mandate
// mode, with what the payout needs and the assurance it reports. An undefined
// setting means the project stored none and gets the default.
type Row = [
  kycRail: boolean,
  setting: RecipientRequirement | undefined,
  mode: RecipientMode,
  needs: readonly IdentityProviderName[],
  assurance: Assurance,
];

const TABLE: readonly Row[] = [
  [false, undefined, 'allowlist', ['self'], 'document_zk'],
  [false, undefined, 'attested', ['self'], 'document_zk'],
  [false, undefined, 'both', ['self'], 'document_zk'],
  [false, 'self_pre_kyc', 'allowlist', ['self'], 'document_zk'],
  [false, 'self_pre_kyc', 'attested', ['self'], 'document_zk'],
  [false, 'self_pre_kyc', 'both', ['self'], 'document_zk'],
  [false, 'principal_attested', 'allowlist', ['principal'], 'principal_kyc'],
  [false, 'principal_attested', 'attested', ['principal'], 'principal_kyc'],
  [false, 'principal_attested', 'both', ['principal'], 'principal_kyc'],
  [false, 'none', 'allowlist', [], 'none'],
  [false, 'none', 'attested', ['self'], 'document_zk'],
  [false, 'none', 'both', ['self'], 'document_zk'],
  [true, undefined, 'allowlist', ['self', 'sep12'], 'anchor_kyc'],
  [true, undefined, 'attested', ['self', 'sep12'], 'anchor_kyc'],
  [true, undefined, 'both', ['self', 'sep12'], 'anchor_kyc'],
  [true, 'self_pre_kyc', 'allowlist', ['self', 'sep12'], 'anchor_kyc'],
  [true, 'self_pre_kyc', 'attested', ['self', 'sep12'], 'anchor_kyc'],
  [true, 'self_pre_kyc', 'both', ['self', 'sep12'], 'anchor_kyc'],
  [true, 'principal_attested', 'allowlist', ['principal', 'sep12'], 'anchor_kyc'],
  [true, 'principal_attested', 'attested', ['principal', 'sep12'], 'anchor_kyc'],
  [true, 'principal_attested', 'both', ['principal', 'sep12'], 'anchor_kyc'],
  [true, 'none', 'allowlist', ['sep12'], 'anchor_kyc'],
  [true, 'none', 'attested', ['self', 'sep12'], 'anchor_kyc'],
  [true, 'none', 'both', ['self', 'sep12'], 'anchor_kyc'],
];

const PROVIDERS: readonly IdentityProviderName[] = ['self', 'sep12', 'principal'];

describe('every rail requirement and project setting', () => {
  it.each(TABLE)(
    'kyc rail %s, setting %s, %s mandate: eligible with exactly the needed verifications',
    async (kycRail, setting, mode, needs, assurance) => {
      const w = world({ kycRail, setting, mode });
      for (const provider of needs) w.hold(provider);
      expect(await w.check()).toEqual({ eligible: true, assurance, expiresAt: null });
    },
  );

  it.each(TABLE)(
    'kyc rail %s, setting %s, %s mandate: each needed verification is required',
    async (kycRail, setting, mode, needs) => {
      for (const missing of needs) {
        const w = world({ kycRail, setting, mode });
        // Holding every other provider must not make up for the missing one.
        for (const provider of PROVIDERS) if (provider !== missing) w.hold(provider);
        expect(await w.check()).toEqual({ eligible: false, reason: 'IDENTITY_REQUIRED' });
      }
    },
  );

  it.each(TABLE)(
    'kyc rail %s, setting %s, %s mandate: a provider that is off refuses only where needed',
    async (kycRail, setting, mode, needs) => {
      for (const off of PROVIDERS) {
        const w = world({ kycRail, setting, mode });
        for (const provider of PROVIDERS) w.hold(provider);
        w.setConfig({ providers: { ...ALL_ON.providers, [off]: { enabled: false } } });
        const result = await w.check();
        if (needs.includes(off)) {
          expect(result).toEqual({ eligible: false, reason: 'PROVIDER_UNAVAILABLE' });
        } else {
          expect(result).toMatchObject({ eligible: true });
        }
      }
    },
  );
});

it('expired', async () => {
  const lapsed = world();
  lapsed.hold('self', { status: 'expired' });
  expect(await lapsed.check()).toEqual({ eligible: false, reason: 'IDENTITY_EXPIRED' });

  // Verified but past its expiry, before any sweep has marked it.
  const stale = world();
  stale.hold('self', { expiresAt: TEST_NOW });
  expect(await stale.check()).toEqual({ eligible: false, reason: 'IDENTITY_EXPIRED' });

  const anchor = world({ kycRail: true });
  anchor.hold('self');
  anchor.hold('sep12', { expiresAt: (TEST_NOW - 1n) as UnixSeconds });
  expect(await anchor.check()).toEqual({ eligible: false, reason: 'IDENTITY_EXPIRED' });

  // One second before expiry is still valid, and the expiry is reported.
  const fresh = world();
  const expiresAt = (TEST_NOW + 1n) as UnixSeconds;
  fresh.hold('self', { expiresAt });
  expect(await fresh.check()).toEqual({ eligible: true, assurance: 'document_zk', expiresAt });
  fresh.clock.set(expiresAt);
  expect(await fresh.check()).toEqual({ eligible: false, reason: 'IDENTITY_EXPIRED' });
});

it('revoked', async () => {
  const w = world();
  w.hold('self', { status: 'revoked' });
  expect(await w.check()).toEqual({ eligible: false, reason: 'IDENTITY_REVOKED' });

  const anchor = world({ kycRail: true });
  anchor.hold('self');
  anchor.hold('sep12', { status: 'revoked', expiresAt: (TEST_NOW + 100n) as UnixSeconds });
  expect(await anchor.check()).toEqual({ eligible: false, reason: 'IDENTITY_REVOKED' });
});

describe('identity rows', () => {
  it('pending and rejected rows give their own reasons', async () => {
    const pending = world();
    pending.hold('self', { status: 'pending' });
    expect(await pending.check()).toEqual({ eligible: false, reason: 'IDENTITY_PENDING' });

    const rejected = world();
    rejected.hold('self', { status: 'rejected' });
    expect(await rejected.check()).toEqual({ eligible: false, reason: 'IDENTITY_REJECTED' });
  });

  it('a verified row at the wrong assurance does not count', async () => {
    const w = world();
    w.hold('self', { assurance: 'principal_kyc' });
    expect(await w.check()).toEqual({ eligible: false, reason: 'IDENTITY_REQUIRED' });
  });

  it('an anchor verification counts only for its own anchor', async () => {
    const w = world({ kycRail: true });
    w.hold('self');
    w.hold('sep12', { providerAccount: 'anchor-two' });
    expect(await w.check()).toEqual({ eligible: false, reason: 'IDENTITY_REQUIRED' });
  });

  it("another recipient's verification does not count", async () => {
    const w = world();
    const other = recipientRow(w.scope);
    w.store.putRecipient(other);
    w.store.putIdentity(identityRow(w.scope, other.id));
    expect(await w.check()).toEqual({ eligible: false, reason: 'IDENTITY_REQUIRED' });
  });

  it('reports the strongest assurance and the earliest expiry', async () => {
    const w = world({ kycRail: true });
    const soon = (TEST_NOW + 60n) as UnixSeconds;
    w.hold('self', { expiresAt: (TEST_NOW + 3600n) as UnixSeconds });
    w.hold('sep12', { expiresAt: soon });
    expect(await w.check()).toEqual({ eligible: true, assurance: 'anchor_kyc', expiresAt: soon });

    const later = world({ kycRail: true });
    const first = (TEST_NOW + 30n) as UnixSeconds;
    later.hold('self', { expiresAt: first });
    later.hold('sep12');
    expect(await later.check()).toEqual({
      eligible: true,
      assurance: 'anchor_kyc',
      expiresAt: first,
    });
  });

  it('every provider off still pays an allowlist mandate that needs nothing', async () => {
    const w = world({ setting: 'none', mode: 'allowlist' });
    w.setConfig({});
    expect(await w.check()).toEqual({ eligible: true, assurance: 'none', expiresAt: null });
  });
});

describe('mandate, recipient, method and rail', () => {
  it('a missing or inactive mandate instance is refused first', async () => {
    const w = world();
    w.hold('self');
    w.store.putRecipient({ ...w.recipient, status: 'inactive' });
    w.store.putMandateInstance({ ...w.instance, status: 'paused' });
    expect(await w.check()).toEqual({ eligible: false, reason: 'MANDATE_INACTIVE' });
    expect(
      await w.service.eligibility(w.ctx, { ...w.request, mandateInstanceId: newId() }),
    ).toEqual({ eligible: false, reason: 'MANDATE_INACTIVE' });
  });

  it('a missing or inactive recipient is refused', async () => {
    const w = world();
    w.hold('self');
    w.store.putRecipient({ ...w.recipient, status: 'inactive' });
    expect(await w.check()).toEqual({ eligible: false, reason: 'RECIPIENT_INACTIVE' });
    expect(await w.service.eligibility(w.ctx, { ...w.request, recipientId: newId() })).toEqual({
      eligible: false,
      reason: 'RECIPIENT_INACTIVE',
    });
  });

  it('a method that is missing, disabled, not the recipient or on another network is not bound', async () => {
    const missing = world();
    missing.hold('self');
    expect(
      await missing.service.eligibility(missing.ctx, { ...missing.request, methodId: newId() }),
    ).toEqual({ eligible: false, reason: 'DESTINATION_NOT_BOUND' });

    const disabled = world();
    disabled.hold('self');
    disabled.store.putPayoutMethod({ ...disabled.method, status: 'disabled' });
    expect(await disabled.check()).toEqual({ eligible: false, reason: 'DESTINATION_NOT_BOUND' });

    const foreign = world();
    foreign.hold('self');
    foreign.store.putPayoutMethod({ ...foreign.method, recipientId: newId() });
    expect(await foreign.check()).toEqual({ eligible: false, reason: 'DESTINATION_NOT_BOUND' });

    const elsewhere = world();
    elsewhere.hold('self');
    elsewhere.store.putPayoutMethod({ ...elsewhere.method, network: OTHER_NETWORK });
    elsewhere.rails.put(OTHER_NETWORK, railCapability(WALLET_RAIL));
    expect(await elsewhere.check()).toEqual({ eligible: false, reason: 'DESTINATION_NOT_BOUND' });
  });

  it('a KYC rail method with no anchor is not bound', async () => {
    const w = world({ kycRail: true });
    for (const provider of PROVIDERS) w.hold(provider);
    w.store.putPayoutMethod({ ...w.method, anchorId: null });
    expect(await w.check()).toEqual({ eligible: false, reason: 'DESTINATION_NOT_BOUND' });
  });

  it('a rail that is unknown or switched off is unavailable', async () => {
    const off = world();
    off.hold('self');
    off.rails.put(TEST_NETWORK, railCapability(WALLET_RAIL, { enabled: false }));
    expect(await off.check()).toEqual({ eligible: false, reason: 'RAIL_UNAVAILABLE' });

    const unknown = world();
    unknown.hold('self');
    unknown.store.putPayoutMethod({ ...unknown.method, network: OTHER_NETWORK });
    unknown.store.putMandateInstance({
      ...unknown.instance,
      mandate: { ...unknown.instance.mandate, network: OTHER_NETWORK },
    });
    expect(await unknown.check()).toEqual({ eligible: false, reason: 'RAIL_UNAVAILABLE' });
  });
});

describe('tenants', () => {
  it("another tenant's ids read as absent", async () => {
    const w = world();
    w.hold('self');
    const intruder = { scope: newScope(), correlationId: 'trace-2' };
    expect(await w.service.eligibility(intruder, w.request)).toEqual({
      eligible: false,
      reason: 'MANDATE_INACTIVE',
    });
  });

  it('a verification stored under another tenant does not count, even for the same ids', async () => {
    const w = world();
    const other: TenantScope = { principalId: w.scope.principalId, projectId: newId() };
    w.store.putIdentity(identityRow(other, w.recipient.id));
    expect(await w.check()).toEqual({ eligible: false, reason: 'IDENTITY_REQUIRED' });
  });

  it('a store that returns a row of another tenant fails the call', async () => {
    const w = world();
    w.hold('self');
    const leaky: IdentityStore = {
      recipient: (scope, id) => w.store.recipient(scope, id),
      payoutMethod: (scope, id) => w.store.payoutMethod(scope, id),
      mandateInstance: (scope, id) => w.store.mandateInstance(scope, id),
      projectSettings: (scope) => w.store.projectSettings(scope),
      identities: async (scope, id) => [
        ...(await w.store.identities(scope, id)),
        identityRow(newScope(), id),
      ],
    };
    const service = createIdentityService({
      store: leaky,
      rails: w.rails,
      clock: w.clock,
      config: () => parseIdentityConfig(ALL_ON),
    });
    await expect(service.eligibility(w.ctx, w.request)).rejects.toThrow(
      IdentityTenantMismatchError,
    );
  });
});

describe('input', () => {
  it('malformed ids are refused with their field names only', async () => {
    const w = world();
    const bad = { ...w.request, recipientId: 'not-a-uuid' } as unknown as EligibilityRequest;
    const error = await w.service.eligibility(w.ctx, bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityInputError);
    expect((error as IdentityInputError).issues).toEqual(['recipientId (invalid_format)']);
    expect(JSON.stringify((error as IdentityInputError).issues)).not.toContain('not-a-uuid');
  });

  it('a malformed tenant or a missing trace id is refused', async () => {
    const w = world();
    const badScope = {
      scope: { principalId: 'x', projectId: w.scope.projectId },
      correlationId: 't',
    };
    await expect(
      w.service.eligibility(badScope as unknown as typeof w.ctx, w.request),
    ).rejects.toThrow(IdentityInputError);
    await expect(
      w.service.eligibility({ scope: w.scope, correlationId: '' }, w.request),
    ).rejects.toThrow(IdentityInputError);
  });

  it('an aborted call does not read the store', async () => {
    const w = world();
    const controller = new AbortController();
    controller.abort(new Error('caller gave up'));
    await expect(
      w.service.eligibility({ ...w.ctx, signal: controller.signal }, w.request),
    ).rejects.toThrow('caller gave up');
  });

  it('stored project settings that fail the schema are a configuration error', async () => {
    const w = world();
    w.store.putProjectSettings(w.scope, { recipientRequirement: 'trust_me' });
    await expect(w.check()).rejects.toThrow(IdentityConfigError);
  });
});
