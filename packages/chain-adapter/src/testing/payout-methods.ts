// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Payout methods held in memory, standing in for the recipient tables, so a test
// gives the fake its legs' destinations the way production gives the real adapter
// them. It answers for any tenant, since a test names the methods it pays to.

import type { Destination, PayoutMethodSource, TenantScope, Uuid } from '../types.js';

export class MemoryPayoutMethods implements PayoutMethodSource {
  readonly #methods = new Map<string, Destination>();
  #count = 0;

  /** A new method paying `destination`, and its id. */
  add(destination: Destination): Uuid {
    this.#count += 1;
    const id = `00000000-0000-4000-9000-${this.#count.toString().padStart(12, '0')}` as Uuid;
    this.#methods.set(id, destination);
    return id;
  }

  destination(_scope: TenantScope, methodId: string): Promise<Destination | null> {
    return Promise.resolve(this.#methods.get(methodId) ?? null);
  }
}
