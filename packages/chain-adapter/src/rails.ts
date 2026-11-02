// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { RailId } from './types.js';

/**
 * Every rail an adapter can deliver through, as a runtime list. The routing
 * configuration names rails by these IDs, and validating against this list
 * keeps the router from spelling any of them itself.
 */
export const RAIL_IDS = Object.freeze([
  'stellar.wallet',
  'stellar.sep31',
] as const satisfies readonly RailId[]);

const KNOWN: ReadonlySet<unknown> = new Set<unknown>(RAIL_IDS);

export function isRailId(value: unknown): value is RailId {
  return KNOWN.has(value);
}
