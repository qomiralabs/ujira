// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a key is doing right now, and the words for its permissions. Pure, so
// the screen and its tests read the same answers.

import { API_KEY_PRESETS, type ApiKeyListItem, type ApiKeyPreset } from '../data/api-keys';

/** Keys this close to their expiry are marked in the list. */
export const EXPIRY_WARNING_DAYS = 14;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type KeyState =
  | { kind: 'active'; expiresAt: Date; daysLeft: number; expiringSoon: boolean }
  /** Rotated: its successor exists and this one stops at the end of the overlap. */
  | { kind: 'replaced'; stopsAt: Date }
  | { kind: 'expired'; at: Date }
  | { kind: 'revoked'; at: Date };

type KeyFields = Pick<ApiKeyListItem, 'id' | 'expiresAt' | 'revokedAt'>;

export function keyState(
  key: KeyFields,
  all: readonly Pick<ApiKeyListItem, 'rotatedFromId'>[],
  now: Date,
): KeyState {
  if (key.revokedAt !== null) return { kind: 'revoked', at: new Date(key.revokedAt) };
  const expiresAt = new Date(key.expiresAt);
  if (expiresAt.getTime() <= now.getTime()) return { kind: 'expired', at: expiresAt };
  if (all.some((other) => other.rotatedFromId === key.id)) {
    return { kind: 'replaced', stopsAt: expiresAt };
  }
  const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
  return { kind: 'active', expiresAt, daysLeft, expiringSoon: daysLeft <= EXPIRY_WARNING_DAYS };
}

/** Only a live key that has not been rotated already can be rotated. */
export function canRotate(state: KeyState): boolean {
  return state.kind === 'active';
}

/** Any key that still works can be stopped now, including one in its overlap. */
export function canRevoke(state: KeyState): boolean {
  return state.kind === 'active' || state.kind === 'replaced';
}

/** When the old key stops if rotated now: after the overlap, or at its own expiry if sooner. */
export function overlapEnds(
  key: Pick<ApiKeyListItem, 'expiresAt'>,
  now: Date,
  hours: number,
): Date {
  const overlap = new Date(now.getTime() + hours * HOUR_MS);
  const expiry = new Date(key.expiresAt);
  return expiry < overlap ? expiry : overlap;
}

/** A key is named by its name, or by its prefix when it was made before keys had names. */
export function keyLabel(key: Pick<ApiKeyListItem, 'name' | 'prefix'>): string {
  return key.name ?? key.prefix;
}

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  'payouts:read': 'See payouts',
  'payouts:write': 'Request payouts',
  'approvals:write': 'Approve or reject payouts',
  'recipients:read': 'See recipients',
  'recipients:write': 'Add and change recipients',
  'mandates:read': 'See mandates',
  'mandates:write': 'Set up and change mandates',
  'receipts:read': 'See receipts',
  'webhooks:manage': 'Set up webhooks',
  'corridors:read': 'See countries and payout methods',
};

/** What a scope lets a key do, in plain words. A scope this build does not know shows as it is. */
export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

export const PRESET_LABELS: Readonly<Record<ApiKeyPreset, { label: string; description: string }>> =
  {
    payouts: {
      label: 'Payouts',
      description:
        'Requests payouts, and sees the recipients, mandates and receipts that go with them.',
    },
    read_only: {
      label: 'Read only',
      description: 'Sees payouts, recipients, mandates, receipts and countries. Cannot move money.',
    },
    full: {
      label: 'Full access',
      description: 'Everything a key can do, including approving payouts and changing mandates.',
    },
  };

function samePermissions(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === b.length && b.every((scope) => set.has(scope));
}

/** A preset's name when the scopes are exactly that preset, otherwise how many there are. */
export function scopeSummary(scopes: readonly string[]): {
  label: string;
  preset: ApiKeyPreset | null;
} {
  for (const preset of Object.keys(API_KEY_PRESETS) as ApiKeyPreset[]) {
    if (samePermissions(scopes, API_KEY_PRESETS[preset])) {
      return { label: PRESET_LABELS[preset].label, preset };
    }
  }
  const count = new Set(scopes).size;
  return { label: count === 1 ? '1 permission' : `${String(count)} permissions`, preset: null };
}
