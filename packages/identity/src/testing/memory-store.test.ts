// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { TenantScope, UnixSeconds } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import {
  ManualClock,
  StaticRailCatalog,
  TEST_NETWORK,
  WALLET_RAIL,
  identityRow,
  mandateRow,
  methodRow,
  newId,
  newScope,
  railCapability,
  recipientRow,
  verificationRow,
} from './fixtures.js';
import { InMemoryIdentityStore, tenantKey } from './memory-store.js';

function seeded(scope: TenantScope) {
  const store = new InMemoryIdentityStore();
  const recipient = recipientRow(scope);
  const method = methodRow(scope, recipient.id);
  const instance = mandateRow(scope);
  const identity = identityRow(scope, recipient.id);
  store
    .putRecipient(recipient)
    .putPayoutMethod(method)
    .putMandateInstance(instance)
    .putIdentity(identity)
    .putProjectSettings(scope, { recipientRequirement: 'none' });
  return { store, recipient, method, instance, identity };
}

describe('InMemoryIdentityStore', () => {
  it('reads its own tenant rows', async () => {
    const scope = newScope();
    const { store, recipient, method, instance, identity } = seeded(scope);
    expect(await store.recipient(scope, recipient.id)).toBe(recipient);
    expect(await store.payoutMethod(scope, method.id)).toBe(method);
    expect(await store.mandateInstance(scope, instance.id)).toBe(instance);
    expect(await store.identities(scope, recipient.id)).toEqual([identity]);
    expect(await store.projectSettings(scope)).toEqual({ recipientRequirement: 'none' });
  });

  it('every read under another tenant comes back empty, for the same ids', async () => {
    const owner = newScope();
    const { store, recipient, method, instance } = seeded(owner);
    const others: TenantScope[] = [
      newScope(),
      { principalId: owner.principalId, projectId: newId() },
      { principalId: newId(), projectId: owner.projectId },
    ];
    for (const other of others) {
      expect(await store.recipient(other, recipient.id)).toBeNull();
      expect(await store.payoutMethod(other, method.id)).toBeNull();
      expect(await store.mandateInstance(other, instance.id)).toBeNull();
      expect(await store.identities(other, recipient.id)).toEqual([]);
      expect(await store.projectSettings(other)).toBeNull();
    }
  });

  it('keeps one identity per provider and account for a recipient', async () => {
    const scope = newScope();
    const store = new InMemoryIdentityStore();
    const recipientId = newId();
    const first = identityRow(scope, recipientId, { status: 'pending' });
    const second = identityRow(scope, recipientId, { status: 'verified' });
    const anchorA = identityRow(scope, recipientId, { provider: 'sep12', providerAccount: 'a' });
    const anchorB = identityRow(scope, recipientId, { provider: 'sep12', providerAccount: 'b' });
    const elsewhere = identityRow(newScope(), recipientId);
    store.putIdentity(first).putIdentity(anchorA).putIdentity(anchorB).putIdentity(elsewhere);
    store.putIdentity(second);
    expect(await store.identities(scope, recipientId)).toEqual([anchorA, anchorB, second]);
  });

  it('the latest verification of a method is the last recorded, within its tenant', async () => {
    const scope = newScope();
    const store = new InMemoryIdentityStore();
    const method = methodRow(scope, newId());
    const first = verificationRow(method, { level: 'wallet_session', signerKey: null });
    const second = verificationRow(method);
    const otherMethod = verificationRow(methodRow(scope, newId()));
    store.putVerification(first).putVerification(second).putVerification(otherMethod);
    expect(await store.latestVerification(scope, method.id)).toBe(second);
    expect(await store.verification(scope, first.id)).toBe(first);
    expect(await store.latestVerification(newScope(), method.id)).toBeNull();
    expect(await store.verification(newScope(), first.id)).toBeNull();
    expect(await store.latestVerification(scope, newId())).toBeNull();
  });

  it('tenant keys differ when either half differs', () => {
    const a = newScope();
    expect(tenantKey(a)).toBe(tenantKey({ ...a }));
    expect(tenantKey(a)).not.toBe(tenantKey({ ...a, projectId: newId() }));
    expect(tenantKey(a)).not.toBe(tenantKey({ ...a, principalId: newId() }));
  });
});

describe('fixtures', () => {
  it('the rail catalog and the clock hold what a test puts in them', () => {
    const wallet = railCapability(WALLET_RAIL);
    const rails = new StaticRailCatalog().put(TEST_NETWORK, wallet);
    expect(rails.rail(TEST_NETWORK, WALLET_RAIL)).toBe(wallet);
    const clock = new ManualClock();
    const later = (clock.nowSeconds() + 5n) as UnixSeconds;
    clock.set(later);
    expect(clock.nowSeconds()).toBe(later);
  });
});
