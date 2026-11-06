// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The custody rule as data. The mandates package applies it at creation and when a
// managed agent is added, and the signer applies its own copy on every signature, because
// the signer ships only what it must load to sign. Both are tested against these cases, so
// the two copies cannot drift apart.

import type { RecipientMode } from './custody.js';

export interface CustodyVector {
  /** The recipient modes of every mandate the key is seated on. */
  readonly seats: readonly RecipientMode[];
  readonly allowed: boolean;
}

export const CUSTODY_VECTORS: readonly CustodyVector[] = Object.freeze([
  { seats: [], allowed: true },
  { seats: ['allowlist'], allowed: true },
  { seats: ['both'], allowed: true },
  { seats: ['allowlist', 'both'], allowed: true },
  { seats: ['attested'], allowed: false },
  { seats: ['allowlist', 'attested'], allowed: false },
  { seats: ['both', 'attested'], allowed: false },
  { seats: ['attested', 'attested'], allowed: false },
]);
