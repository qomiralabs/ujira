// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { generateFixtures } from './generate.js';
import type { FixtureSet } from './generate.js';

export {
  EDGE_NAMES,
  generateFixtures,
  toMandateListItem,
  toPayoutListItem,
  toReceiptListItem,
} from './generate.js';
export { LOW_BALANCE_CASES } from './generate.js';
export type {
  FixtureOptions,
  FixtureRecipient,
  FixtureSet,
  FixtureTenant,
  LowBalanceCase,
} from './generate.js';
export { checkFixtures } from './check.js';
export type { FixtureFailure } from './check.js';
export { Rng } from './rng.js';

export const EDGE_SEED = 283;
export const EDGE_PAYOUT_COUNT = 10_000;

/** The edge set: every status and the awkward cases, at table scale. */
export function edgeFixtures(): FixtureSet {
  return generateFixtures({ seed: EDGE_SEED, payouts: EDGE_PAYOUT_COUNT, edge: true });
}
