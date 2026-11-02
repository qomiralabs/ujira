// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The sponsorship ledger in memory, and the contract any implementation must
// meet, so the database store in the db package is held to the same rules.

import { describe, expect, it } from 'vitest';

import type { NetworkId } from '../networks.js';
import type { ActivationKey, SponsorshipLedger, SponsorshipRow } from '../sponsorship/ledger.js';
import type { TenantScope, UnixSeconds } from '../types.js';

function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId;
}

export function createMemorySponsorshipLedger(): SponsorshipLedger & {
  readonly rows: readonly SponsorshipRow[];
} {
  const rows = new Map<string, SponsorshipRow>();
  const shortfalls = new Map<string, bigint>();
  const queues = new Map<NetworkId, Promise<unknown>>();
  return {
    get rows() {
      return [...rows.values()];
    },
    atomically<T>(network: NetworkId, work: () => Promise<T>): Promise<T> {
      const run = (queues.get(network) ?? Promise.resolve()).then(work, work);
      queues.set(network, run);
      return run;
    },
    insert(row) {
      if (rows.has(row.reservationId)) return Promise.resolve(false);
      rows.set(row.reservationId, row);
      return Promise.resolve(true);
    },
    get(reservationId) {
      return Promise.resolve(rows.get(reservationId) ?? null);
    },
    settle(scope, reservationId, actualFeeStroops, rentStroops) {
      const row = rows.get(reservationId);
      if (row?.state === 'reserved' && sameScope(row.scope, scope)) {
        rows.set(reservationId, { ...row, state: 'settled', actualFeeStroops, rentStroops });
      }
      return Promise.resolve();
    },
    release(scope, reservationId) {
      const row = rows.get(reservationId);
      if (row?.state === 'reserved' && sameScope(row.scope, scope)) {
        rows.set(reservationId, { ...row, state: 'released' });
      }
      return Promise.resolve();
    },
    totals(query) {
      let count = 0;
      let stroops = 0n;
      for (const row of rows.values()) {
        if (
          row.state !== 'released' &&
          row.network === query.network &&
          row.reservedAt >= query.since &&
          (query.principalId === undefined || row.scope.principalId === query.principalId) &&
          (query.intents === undefined || query.intents.includes(row.intent))
        ) {
          count += 1;
          stroops += row.actualFeeStroops ?? row.maxFeeStroops;
        }
      }
      return Promise.resolve({ count, stroops });
    },
    activationExists(network, key: ActivationKey) {
      for (const row of rows.values()) {
        if (row.state === 'released' || row.activation === null) continue;
        const sameRecipient =
          row.network === network && row.activation.recipientId === key.recipientId;
        if (sameRecipient || row.activation.account === key.account) return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    addShortfall(network, month, stroops) {
      const key = `${network}|${month}`;
      const total = (shortfalls.get(key) ?? 0n) + stroops;
      shortfalls.set(key, total);
      return Promise.resolve(total);
    },
    shortfall(network, month) {
      return Promise.resolve(shortfalls.get(`${network}|${month}`) ?? 0n);
    },
  };
}

export interface SponsorshipLedgerHarness {
  readonly ledger: SponsorshipLedger;
  readonly network: NetworkId;
  readonly otherNetwork: NetworkId;
  readonly scope: TenantScope;
  readonly otherScope: TenantScope;
}

const AT = 1_800_000_000n as UnixSeconds;

/** The rules a sponsorship ledger keeps, for the in-memory one and the database one alike. */
export function describeSponsorshipLedger(
  name: string,
  factory: () => SponsorshipLedgerHarness | Promise<SponsorshipLedgerHarness>,
): void {
  const row = (
    h: SponsorshipLedgerHarness,
    over: Partial<SponsorshipRow> = {},
  ): SponsorshipRow => ({
    reservationId: 'r1',
    scope: h.scope,
    network: h.network,
    intent: 'pause',
    state: 'reserved',
    maxFeeStroops: 100n,
    actualFeeStroops: null,
    rentStroops: null,
    reservedAt: AT,
    activation: null,
    ...over,
  });

  describe(`sponsorship ledger contract: ${name}`, () => {
    it('the same reservation id written twice leaves one ledger row', async () => {
      const h = await factory();
      expect(await h.ledger.insert(row(h))).toBe(true);
      expect(await h.ledger.insert(row(h, { maxFeeStroops: 999n }))).toBe(false);
      expect((await h.ledger.get('r1'))?.maxFeeStroops).toBe(100n);
      const totals = await h.ledger.totals({ network: h.network, since: AT });
      expect(totals).toEqual({ count: 1, stroops: 100n });
    });

    it('counts a settled row at its cost, a reserved one at its most, and a released one not at all', async () => {
      const h = await factory();
      await h.ledger.insert(row(h, { reservationId: 'settled' }));
      await h.ledger.insert(row(h, { reservationId: 'reserved' }));
      await h.ledger.insert(row(h, { reservationId: 'released' }));
      await h.ledger.settle(h.scope, 'settled', 40n, 7n);
      await h.ledger.release(h.scope, 'released');
      expect(await h.ledger.totals({ network: h.network, since: AT })).toEqual({
        count: 2,
        stroops: 140n,
      });
      expect(await h.ledger.get('settled')).toMatchObject({
        state: 'settled',
        actualFeeStroops: 40n,
        rentStroops: 7n,
      });
    });

    it('filters totals by time, network, principal and intent', async () => {
      const h = await factory();
      await h.ledger.insert(row(h, { reservationId: 'a' }));
      await h.ledger.insert(row(h, { reservationId: 'b', scope: h.otherScope }));
      await h.ledger.insert(row(h, { reservationId: 'c', network: h.otherNetwork }));
      await h.ledger.insert(row(h, { reservationId: 'd', intent: 'revoke' }));
      await h.ledger.insert(row(h, { reservationId: 'e', reservedAt: (AT - 1n) as UnixSeconds }));
      const { network } = h;
      expect((await h.ledger.totals({ network, since: AT })).count).toBe(3);
      const principalId = h.scope.principalId;
      expect((await h.ledger.totals({ network, since: AT, principalId })).count).toBe(2);
      expect((await h.ledger.totals({ network, since: AT, intents: ['revoke'] })).count).toBe(1);
      expect((await h.ledger.totals({ network, since: (AT - 1n) as UnixSeconds })).count).toBe(4);
    });

    it('moves only reserved rows, only forward, and only for their own tenant', async () => {
      const h = await factory();
      await h.ledger.insert(row(h));
      await h.ledger.settle(h.otherScope, 'r1', 1n, null);
      await h.ledger.release(h.otherScope, 'r1');
      expect((await h.ledger.get('r1'))?.state).toBe('reserved');
      await h.ledger.settle(h.scope, 'r1', 40n, null);
      await h.ledger.release(h.scope, 'r1');
      await h.ledger.settle(h.scope, 'r1', 90n, null);
      expect(await h.ledger.get('r1')).toMatchObject({ state: 'settled', actualFeeStroops: 40n });
      await h.ledger.settle(h.scope, 'missing', 1n, null);
      await h.ledger.release(h.scope, 'missing');
      expect(await h.ledger.get('missing')).toBeNull();
    });

    it('finds an activation by recipient per network and by account on any network, while it is live', async () => {
      const h = await factory();
      const activation = { recipientId: 'recipient', account: 'account' };
      const other = { recipientId: 'someone', account: 'elsewhere' };
      await h.ledger.insert(row(h, { intent: 'recipient_activation', activation }));
      const { network, otherNetwork } = h;
      expect(await h.ledger.activationExists(network, activation)).toBe(true);
      expect(await h.ledger.activationExists(network, { ...other, recipientId: 'recipient' })).toBe(
        true,
      );
      expect(await h.ledger.activationExists(otherNetwork, { ...other, account: 'account' })).toBe(
        true,
      );
      expect(
        await h.ledger.activationExists(otherNetwork, { ...other, recipientId: 'recipient' }),
      ).toBe(false);
      expect(await h.ledger.activationExists(network, other)).toBe(false);
      await h.ledger.release(h.scope, 'r1');
      expect(await h.ledger.activationExists(network, activation)).toBe(false);
    });

    it('adds shortfalls per network and month', async () => {
      const h = await factory();
      expect(await h.ledger.addShortfall(h.network, '2027-01', 5n)).toBe(5n);
      expect(await h.ledger.addShortfall(h.network, '2027-01', 6n)).toBe(11n);
      expect(await h.ledger.shortfall(h.network, '2027-01')).toBe(11n);
      expect(await h.ledger.shortfall(h.network, '2027-02')).toBe(0n);
      expect(await h.ledger.shortfall(h.otherNetwork, '2027-01')).toBe(0n);
    });

    it('runs atomic sections on one network one at a time, and survives one that fails', async () => {
      const h = await factory();
      const order: string[] = [];
      const slow = h.ledger.atomically(h.network, async () => {
        order.push('a in');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('a out');
        throw new Error('failed');
      });
      const next = h.ledger.atomically(h.network, () => {
        order.push('b');
        return Promise.resolve('done');
      });
      await expect(slow).rejects.toThrow('failed');
      expect(await next).toBe('done');
      expect(order).toEqual(['a in', 'a out', 'b']);
    });
  });
}
