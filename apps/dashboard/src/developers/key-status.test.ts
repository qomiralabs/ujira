// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import type { ApiKeyListItem } from '../data/api-keys';
import {
  canRevoke,
  canRotate,
  keyLabel,
  keyState,
  overlapEnds,
  scopeLabel,
  scopeSummary,
} from './key-status';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const DAY = 86_400_000;

function at(offsetDays: number): string {
  return new Date(NOW.getTime() + offsetDays * DAY).toISOString();
}

function key(overrides: Partial<ApiKeyListItem> = {}): ApiKeyListItem {
  return {
    principalId: '6d1f4a52-6f0e-4b8e-9f7e-0c4b9d7a1e01',
    projectId: '6d1f4a52-6f0e-4b8e-9f7e-0c4b9d7a1e02',
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Payroll server',
    prefix: 'ujk_test_abcdefghijklmnop',
    scopes: ['payouts:read'],
    expiresAt: at(100),
    revokedAt: null,
    rotatedFromId: null,
    createdAt: at(-30),
    lastUsedAt: null,
    ...overrides,
  };
}

describe('keyState', () => {
  it('is active with the whole days left, and not marked when more than 14 remain', () => {
    expect(keyState(key({ expiresAt: at(15) }), [], NOW)).toEqual({
      kind: 'active',
      expiresAt: new Date(at(15)),
      daysLeft: 15,
      expiringSoon: false,
    });
  });

  it('marks a key expiring within 14 days', () => {
    const state = keyState(key({ expiresAt: at(14) }), [], NOW);
    expect(state).toMatchObject({ kind: 'active', daysLeft: 14, expiringSoon: true });
    expect(keyState(key({ expiresAt: at(0.25) }), [], NOW)).toMatchObject({
      daysLeft: 1,
      expiringSoon: true,
    });
  });

  it('is expired from the moment its expiry passes', () => {
    expect(keyState(key({ expiresAt: NOW.toISOString() }), [], NOW)).toEqual({
      kind: 'expired',
      at: NOW,
    });
  });

  it('is revoked whatever else is true, since revoking stops it at once', () => {
    const revoked = key({ revokedAt: at(-1), expiresAt: at(-5) });
    expect(keyState(revoked, [], NOW)).toEqual({ kind: 'revoked', at: new Date(at(-1)) });
  });

  it('is being replaced while its successor exists and its overlap runs', () => {
    const old = key({ expiresAt: at(1) });
    const successor = key({ id: '00000000-0000-4000-8000-000000000002', rotatedFromId: old.id });
    expect(keyState(old, [old, successor], NOW)).toEqual({
      kind: 'replaced',
      stopsAt: new Date(at(1)),
    });
    // Once the overlap is over it is simply expired.
    expect(keyState(key({ expiresAt: at(-1) }), [old, successor], NOW).kind).toBe('expired');
  });
});

describe('actions', () => {
  it('rotates only a live key that has not been rotated, and revokes any key still working', () => {
    const active = keyState(key(), [], NOW);
    const old = key({ expiresAt: at(1) });
    const replaced = keyState(old, [old, key({ id: 'x', rotatedFromId: old.id })], NOW);
    const expired = keyState(key({ expiresAt: at(-1) }), [], NOW);
    const revoked = keyState(key({ revokedAt: at(-1) }), [], NOW);
    expect([active, replaced, expired, revoked].map(canRotate)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([active, replaced, expired, revoked].map(canRevoke)).toEqual([true, true, false, false]);
  });

  it('ends the overlap at the old expiry when that comes sooner', () => {
    expect(overlapEnds(key({ expiresAt: at(100) }), NOW, 24)).toEqual(new Date(at(1)));
    expect(overlapEnds(key({ expiresAt: at(0.5) }), NOW, 24)).toEqual(new Date(at(0.5)));
  });
});

describe('labels', () => {
  it('names a key by its name, or by its prefix when it predates names', () => {
    expect(keyLabel(key())).toBe('Payroll server');
    expect(keyLabel(key({ name: null }))).toBe('ujk_test_abcdefghijklmnop');
  });

  it('says what each scope lets a key do, and shows an unknown one as it is', () => {
    expect(scopeLabel('payouts:write')).toBe('Request payouts');
    expect(scopeLabel('reports:read')).toBe('reports:read');
  });

  it('names a preset when the scopes are exactly one, in any order', () => {
    expect(
      scopeSummary([
        'receipts:read',
        'payouts:read',
        'payouts:write',
        'recipients:read',
        'mandates:read',
      ]),
    ).toEqual({ label: 'Payouts', preset: 'payouts' });
    expect(scopeSummary(['payouts:read'])).toEqual({ label: '1 permission', preset: null });
    expect(scopeSummary(['payouts:read', 'receipts:read'])).toEqual({
      label: '2 permissions',
      preset: null,
    });
  });
});
