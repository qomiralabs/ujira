// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { NetworkId } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { evidenceAccepted, sameDestination } from './evidence.js';
import { accountOf, methodRow, newId, newScope, verificationRow } from './testing/index.js';
import type { VerificationLevel } from './types.js';

const OTHER_NETWORK: NetworkId = 'stellar:pubnet';
const scope = newScope();
const method = methodRow(scope, newId());
const destination = method.destination;

const TABLE: [VerificationLevel, boolean, boolean][] = [
  // level, accepted in attested mode, accepted in both mode
  ['wallet_signature', true, true],
  ['wallet_session', false, true],
  ['partner_confirmed', true, true],
  ['principal_asserted', false, true],
];

describe('evidence accepted for attestation', () => {
  it.each(TABLE)('%s: attested %s, both %s', (level, attested, both) => {
    const row = verificationRow(method, { level });
    expect(evidenceAccepted('attested', destination, row, null)).toBe(attested);
    expect(evidenceAccepted('both', destination, row, null)).toBe(both);
  });

  it('evidence for another address, network or tag does not count', () => {
    const row = verificationRow(method);
    const moved = [
      { ...destination, tag: 5n },
      { ...destination, address: { ...destination.address, value: accountOf('elsewhere') } },
      { ...destination, address: { ...destination.address, network: OTHER_NETWORK } },
    ];
    for (const other of moved) {
      expect(sameDestination(other, destination)).toBe(false);
      expect(evidenceAccepted('both', other, row, null)).toBe(false);
    }
    expect(sameDestination({ ...destination }, destination)).toBe(true);
  });

  it('a forwarder counts only on its own wallet verified at a wallet level', () => {
    const wallet = methodRow(scope, method.recipientId);
    const bases: [VerificationLevel, boolean][] = [
      ['wallet_signature', true],
      ['wallet_session', true],
      ['partner_confirmed', false],
      ['principal_asserted', false],
      ['forwarder_derived', false],
    ];
    for (const [level, accepted] of bases) {
      const base = verificationRow(wallet, { level });
      const forwarder = verificationRow(method, {
        level: 'forwarder_derived',
        signerKey: null,
        derivedFrom: base.id,
      });
      expect(evidenceAccepted('attested', destination, forwarder, base), level).toBe(accepted);
      expect(evidenceAccepted('both', destination, forwarder, base), level).toBe(accepted);
    }
    const base = verificationRow(wallet);
    const pointsElsewhere = verificationRow(method, {
      level: 'forwarder_derived',
      derivedFrom: newId(),
    });
    expect(evidenceAccepted('attested', destination, pointsElsewhere, base)).toBe(false);
    expect(evidenceAccepted('attested', destination, pointsElsewhere, null)).toBe(false);
  });
});
