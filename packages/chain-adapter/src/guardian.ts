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
