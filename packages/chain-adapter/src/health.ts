// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { SignerHealth } from './signer.js';
import type { ChainHealth } from './types.js';

/** The reason a network reports while its signer is down. */
export const SIGNER_DOWN = 'SIGNER_DOWN';

/** The reasons a network reports while its fee sponsor is short. */
export const SPONSOR_LOW = 'SPONSOR_LOW';
export const SPONSOR_UNFUNDED = 'SPONSOR_UNFUNDED';

/**
 * Folds the fee sponsor's balance into the network's health. Below its minimum
 * nothing sponsored can go out, but reads and executor work still can, so the
 * network is degraded rather than down. Merely low changes no state: it is a
 * reason for operations to act while everything still works.
 */
export function withSponsorHealth(
  health: Omit<ChainHealth, 'sponsorFunded'>,
  funding: 'funded' | 'low' | 'unfunded',
): ChainHealth {
  if (funding === 'funded') return { ...health, sponsorFunded: true };
  const unfunded = funding === 'unfunded';
  const reason = unfunded ? SPONSOR_UNFUNDED : SPONSOR_LOW;
  return {
    ...health,
    sponsorFunded: !unfunded,
    state: unfunded && health.state === 'healthy' ? 'degraded' : health.state,
    reasons: health.reasons.includes(reason) ? health.reasons : [...health.reasons, reason],
  };
}

/**
 * Folds the signer's health into the network's. With no signer nothing can
 * be submitted, but reads, quotes and deposit scans still work, so a signer
 * outage leaves the network degraded rather than down and the router sends
 * new payouts elsewhere until it is back. A state the port does not define
 * counts as down, since a health answer that cannot be read is no answer.
 */
export function withSignerHealth(
  health: Omit<ChainHealth, 'signerHealthy'>,
  signer: SignerHealth,
): ChainHealth {
  const signerHealthy = signer.state === 'healthy' || signer.state === 'degraded';
  if (signerHealthy) return { ...health, signerHealthy };
  return {
    ...health,
    signerHealthy,
    state: health.state === 'healthy' ? 'degraded' : health.state,
    reasons: health.reasons.includes(SIGNER_DOWN)
      ? health.reasons
      : [...health.reasons, SIGNER_DOWN],
  };
}
