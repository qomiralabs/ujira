// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which destination evidence the attester accepts. UJIRA's signature is the
// only thing binding an attested destination, so in attested mode it needs
// evidence the recipient or a partner produced; in both mode the principal
// has also bound the destination on chain, so any recorded level will do.

import type { Destination } from '@ujira/chain-adapter';

import { VERIFICATION_LEVELS } from './types.js';
import type { DestinationVerificationRecord, RecipientMode, VerificationLevel } from './types.js';

export type AttestedMode = 'attested' | 'both';

const ACCEPTED: Readonly<Record<AttestedMode, readonly VerificationLevel[]>> = {
  attested: ['wallet_signature', 'partner_confirmed', 'forwarder_derived'],
  both: [
    'wallet_signature',
    'wallet_session',
    'partner_confirmed',
    'forwarder_derived',
    'principal_asserted',
  ],
};

/**
 * Whether a mode takes a level at all. Allowlist mode takes any, as the
 * principal named the destination on chain themselves. A forwarder's wallet
 * is checked separately by evidenceAccepted.
 */
export function levelAcceptedForMode(mode: RecipientMode, level: VerificationLevel): boolean {
  const accepted: readonly VerificationLevel[] =
    mode === 'allowlist' ? VERIFICATION_LEVELS : ACCEPTED[mode];
  return accepted.includes(level);
}

/** A forwarder is only as good as the wallet it forwards to. */
const FORWARDER_BASES: readonly VerificationLevel[] = ['wallet_signature', 'wallet_session'];

export function sameDestination(a: Destination, b: Destination): boolean {
  return (
    a.address.network === b.address.network &&
    a.address.value === b.address.value &&
    a.tag === b.tag
  );
}

/**
 * Whether the method's latest evidence lets the attester sign for it. The
 * evidence must be for the destination the method holds now, so a method
 * whose destination changed after it was verified is unverified again.
 */
export function evidenceAccepted(
  mode: AttestedMode,
  destination: Destination,
  latest: DestinationVerificationRecord,
  base: DestinationVerificationRecord | null,
): boolean {
  if (!ACCEPTED[mode].includes(latest.level)) return false;
  if (!sameDestination(latest.destination, destination)) return false;
  if (latest.level !== 'forwarder_derived') return true;
  return base !== null && base.id === latest.derivedFrom && FORWARDER_BASES.includes(base.level);
}
