// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The event intake store in memory, enforcing the unique keys the database
// enforces, so a test that passes here cannot rely on a rule that is not there.
// It is also the registry the adapter reads, which is the path in production:
// what intake registers is what the adapter then accepts. Test code only.

import type {
  EventBooking,
  EventIntakeStore,
  MandateFlagReason,
  MandateTenant,
  NewRegistration,
} from '../intake.js';
import type { NetworkId } from '../networks.js';
import type { MandateRegistration, MandateRegistry, TenantScope, UnixSeconds } from '../types.js';

export interface MandateAlert {
  readonly contractId: string;
  readonly reason: MandateFlagReason;
}

function key(...parts: readonly (string | bigint)[]): string {
  return parts.map(String).join('|');
}

export class MemoryEventIntakeStore implements EventIntakeStore, MandateRegistry {
  readonly #registrations = new Map<string, MandateRegistration>();
  readonly #tenants = new Map<string, MandateTenant & { readonly claimedAt: UnixSeconds }>();
  readonly #events = new Map<string, EventBooking>();
  readonly #payouts = new Map<string, EventBooking[]>();
  readonly #alerts = new Map<string, MandateAlert>();

  /** A tenant claims a contract, as its mandate instance row does. */
  claim(
    network: NetworkId,
    contractId: string,
    tenant: MandateTenant,
    claimedAt = 0n as UnixSeconds,
  ): void {
    this.#tenants.set(key(network, contractId), { ...tenant, claimedAt });
  }

  /** Every stored event, oldest first. */
  get events(): readonly EventBooking[] {
    return [...this.#events.values()];
  }

  /** The events of each payout, by network, contract and payout ID. */
  get payouts(): ReadonlyMap<string, readonly EventBooking[]> {
    return this.#payouts;
  }

  /** One per mandate and reason, however many times it was flagged for it. */
  get alerts(): readonly MandateAlert[] {
    return [...this.#alerts.values()];
  }

  get registrations(): readonly MandateRegistration[] {
    return [...this.#registrations.values()];
  }

  claimedAt(
    scope: TenantScope,
    network: NetworkId,
    contractId: string,
  ): Promise<UnixSeconds | null> {
    const tenant = this.#tenants.get(key(network, contractId));
    return Promise.resolve(
      tenant?.scope.principalId === scope.principalId && tenant.scope.projectId === scope.projectId
        ? tenant.claimedAt
        : null,
    );
  }

  registered(network: NetworkId, contractId: string): Promise<MandateRegistration | null> {
    return Promise.resolve(this.#registrations.get(key(network, contractId)) ?? null);
  }

  register(r: NewRegistration): Promise<boolean> {
    const at = key(r.network, r.contractId);
    if (this.#registrations.has(at)) return Promise.resolve(false);
    this.#registrations.set(at, {
      network: r.network,
      contractId: r.contractId,
      factory: r.factory,
      tenantTag: r.tenantTag,
      flagged: false,
    });
    return Promise.resolve(true);
  }

  flag(network: NetworkId, contractId: string, reason: MandateFlagReason): Promise<void> {
    const at = key(network, contractId);
    const found = this.#registrations.get(at);
    if (found !== undefined) {
      this.#registrations.set(at, { ...found, flagged: true });
      this.#alerts.set(key(at, reason), { contractId, reason });
    }
    return Promise.resolve();
  }

  tenantOf(network: NetworkId, contractId: string): Promise<MandateTenant | null> {
    const tenant = this.#tenants.get(key(network, contractId));
    return Promise.resolve(
      tenant === undefined
        ? null
        : { scope: tenant.scope, mandateInstanceId: tenant.mandateInstanceId },
    );
  }

  book(booking: EventBooking): Promise<boolean> {
    const at = key(booking.network, booking.txHash, booking.eventIndex);
    if (this.#events.has(at)) return Promise.resolve(false);
    this.#events.set(at, booking);
    if (booking.payoutId !== null) {
      const payout = key(booking.network, booking.contractId, booking.payoutId);
      this.#payouts.set(payout, [...(this.#payouts.get(payout) ?? []), booking]);
    }
    return Promise.resolve(true);
  }
}
