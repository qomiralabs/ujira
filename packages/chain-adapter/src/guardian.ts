// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { NetworksConfig } from './config.js';
import type { NetworkId } from './networks.js';
import type { ChainAddress } from './types.js';

/**
 * The operations guardian configured for a network, or null when the
 * network has none or is not configured. Callers outside the adapter read
 * it through here, so none of them learns what a network section holds.
 */
export function operationsGuardianOf(
  config: NetworksConfig,
  network: NetworkId,
): ChainAddress | null {
  const value = config[network]?.operationsGuardian;
  return value === undefined ? null : Object.freeze({ network, value });
}

/**
 * Every address that has served as a network's operations guardian, the current
 * one first, or none when the network is not configured. A mandate made before a
 * rotation holds an older one, which is still UJIRA's guardian on that mandate.
 */
export function operationsGuardiansOf(
  config: NetworksConfig,
  network: NetworkId,
): readonly ChainAddress[] {
  const section = config[network];
  if (section === undefined) return Object.freeze([]);
  const current = section.operationsGuardian === undefined ? [] : [section.operationsGuardian];
  return Object.freeze(
    [...current, ...section.retiredOperationsGuardians].map((value) =>
      Object.freeze({ network, value }),
    ),
  );
}
