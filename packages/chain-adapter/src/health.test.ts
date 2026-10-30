// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for folding the signer's health into the network's (health.ts).
 *
 * withSignerHealth(health, signer) returns the network health with
 * signerHealthy set. A signer that is down gives signerHealthy false, adds
 * the reason SIGNER_DOWN once, and leaves a healthy network degraded; a
 * network already degraded or down keeps its state. A healthy or degraded
 * signer changes nothing else. A state outside the three counts as down.
 */

import { describe, expect, it } from 'vitest';

import { SIGNER_DOWN, withSignerHealth } from './index.js';
import type { ChainHealth, HealthState, SignerHealth, UnixSeconds } from './index.js';

const NOW = 1_767_229_200n as UnixSeconds;

function network(
  state: HealthState,
  reasons: readonly string[] = [],
): Omit<ChainHealth, 'signerHealthy'> {
  return {
    network: 'stellar:testnet',
    state,
    checkedAt: NOW,
    headLagSeconds: 4,
    rpcP95Ms: 180,
    submitSuccessRate5m: 10_000,
    sponsorFunded: true,
    executorFunded: true,
    rails: [{ rail: 'stellar.wallet', state: 'healthy' }],
    reasons,
  };
}

function signer(state: HealthState): SignerHealth {
  return { state, checkedAt: NOW, signP95Ms: 40, reasons: state === 'down' ? ['THROTTLED'] : [] };
}

describe('withSignerHealth', () => {
  it('signer down gives signerHealthy false and SIGNER_DOWN', () => {
    const health = withSignerHealth(network('healthy'), signer('down'));
    expect(health.signerHealthy).toBe(false);
    expect(health.reasons).toEqual([SIGNER_DOWN]);
    expect(SIGNER_DOWN).toBe('SIGNER_DOWN');
    // Degraded, so the router moves new payouts elsewhere, but not down.
    expect(health.state).toBe('degraded');
    expect(health.rails).toEqual(network('healthy').rails);
  });

  it('keeps a worse network state and the reasons already there', () => {
    const down = withSignerHealth(network('down', ['HEAD_LAG']), signer('down'));
    expect(down.state).toBe('down');
    expect(down.reasons).toEqual(['HEAD_LAG', SIGNER_DOWN]);
    const degraded = withSignerHealth(network('degraded', ['SPONSOR_LOW']), signer('down'));
    expect(degraded.state).toBe('degraded');
    expect(degraded.reasons).toEqual(['SPONSOR_LOW', SIGNER_DOWN]);
  });

  it('adds SIGNER_DOWN only once', () => {
    const health = withSignerHealth(network('degraded', [SIGNER_DOWN]), signer('down'));
    expect(health.reasons).toEqual([SIGNER_DOWN]);
  });

  it.each(['healthy', 'degraded'] as const)('a %s signer leaves the network as it is', (state) => {
    for (const base of [network('healthy'), network('degraded', ['RPC_ERRORS'])]) {
      expect(withSignerHealth(base, signer(state))).toEqual({ ...base, signerHealthy: true });
    }
  });

  it('counts a state it cannot read as down', () => {
    const odd = { ...signer('healthy'), state: 'unknown' as HealthState };
    const health = withSignerHealth(network('healthy'), odd);
    expect(health.signerHealthy).toBe(false);
    expect(health.reasons).toEqual([SIGNER_DOWN]);
  });
});
