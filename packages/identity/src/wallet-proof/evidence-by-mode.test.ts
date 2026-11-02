// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { levelAcceptedForMode } from '../evidence.js';
import { VERIFICATION_LEVELS } from '../types.js';
import type { RecipientMode, VerificationLevel } from '../types.js';

// Every level against every mode. Allowlist mode takes any, because the
// principal bound the destination on chain. Attested mode needs evidence the
// recipient or a partner produced, plus a forwarder on such a wallet, which
// attest checks further. Both is the union of the two.
const TABLE: readonly [VerificationLevel, Record<RecipientMode, boolean>][] = [
  ['wallet_signature', { allowlist: true, attested: true, both: true }],
  ['partner_confirmed', { allowlist: true, attested: true, both: true }],
  ['forwarder_derived', { allowlist: true, attested: true, both: true }],
  ['wallet_session', { allowlist: true, attested: false, both: true }],
  ['principal_asserted', { allowlist: true, attested: false, both: true }],
];

describe('evidence by mode', () => {
  it('the table covers every level', () => {
    expect(TABLE.map(([level]) => level).sort()).toEqual([...VERIFICATION_LEVELS].sort());
  });

  it.each(TABLE)('%s', (level, modes) => {
    for (const mode of ['allowlist', 'attested', 'both'] as const) {
      expect(levelAcceptedForMode(mode, level), mode).toBe(modes[mode]);
    }
  });
});
