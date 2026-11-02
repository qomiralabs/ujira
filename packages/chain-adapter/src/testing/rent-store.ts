// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The rent spend store in memory, for tests. It keeps the same promises a
// database table will: a key counts once, and an alert period is marked
// once.

import type { NetworkId } from '../networks.js';
import type { RentAlertKind, RentSpendStore } from '../stellar/rent-watch.js';

export class InMemoryRentStore implements RentSpendStore {
  private readonly keys = new Set<string>();
  private readonly byDay = new Map<string, bigint>();
  private readonly alerted = new Set<string>();
  private readonly fingerprints = new Map<NetworkId, string>();

  recordSpend(e: {
    readonly network: NetworkId;
    readonly key: string;
    readonly day: string;
    readonly stroops: bigint;
  }): Promise<boolean> {
    const id = `${e.network} ${e.key}`;
    if (this.keys.has(id)) return Promise.resolve(false);
    this.keys.add(id);
    const day = `${e.network} ${e.day}`;
    this.byDay.set(day, (this.byDay.get(day) ?? 0n) + e.stroops);
    return Promise.resolve(true);
  }

  spendOn(network: NetworkId, day: string): Promise<bigint> {
    return Promise.resolve(this.byDay.get(`${network} ${day}`) ?? 0n);
  }

  markAlerted(network: NetworkId, kind: RentAlertKind, period: string): Promise<boolean> {
    const id = `${network} ${kind} ${period}`;
    if (this.alerted.has(id)) return Promise.resolve(false);
    this.alerted.add(id);
    return Promise.resolve(true);
  }

  settingsFingerprint(network: NetworkId): Promise<string | null> {
    return Promise.resolve(this.fingerprints.get(network) ?? null);
  }

  saveSettingsFingerprint(network: NetworkId, fingerprint: string): Promise<void> {
    this.fingerprints.set(network, fingerprint);
    return Promise.resolve();
  }
}
