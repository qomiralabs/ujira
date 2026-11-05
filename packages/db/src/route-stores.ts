// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The router's storage ports, in Postgres. The router owns the shapes, so only its
// types are imported. Which network a chain's rows are on and which rail a method
// uses are given by the caller from the chain adapter, so this package still knows
// no chain.

import type {
  FundingHoldStore,
  MandateInstance,
  MandateInstances,
  ReleaseTarget,
  RouteRequest,
  VerifiedDestination,
  VerifiedDestinations,
} from '@ujira/router';
import { isTokenAsset, tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';

import type { Database } from './database.js';
import { mandateInstances } from './repositories/mandates.js';
import { fundingHolds, payoutAttempts, payouts } from './repositories/payouts.js';
import { recipients } from './repositories/recipients.js';
import { routing } from './repositories/routing.js';
import { projects } from './repositories/tenancy.js';

type NetworkId = ReleaseTarget['network'];
type Uuid = ReleaseTarget['principalId'];
type RailId = VerifiedDestination['rail'];
type PayoutMethodName = VerifiedDestination['method'];
type MandateRef = MandateInstance['ref'];

export interface RouteStoreOptions {
  readonly db: Pick<Database, 'tenant' | 'principal'>;
  /** The network a chain's rows are on in this deployment. */
  readonly networkOf: (chain: string) => NetworkId;
  /** The rail kind a payout method's rail is, on its chain. */
  readonly railOf: (chain: string, rail: string) => RailId;
  /** When an attempt created now stops being able to land. */
  readonly attemptDeadline: () => Date;
  /**
   * Every principal and network with a hold, for the sweep. A read across tenants,
   * so it belongs to the scheduler role and is given here.
   */
  readonly holdTargets: FundingHoldStore['heldPairs'];
}

export interface RouteStores {
  readonly holds: FundingHoldStore;
  readonly mandates: MandateInstances;
  readonly destinations: VerifiedDestinations;
}

/** A held payout the row cannot be routed from again. A bug, not a state to wait out. */
export class HeldPayoutUnreadableError extends Error {
  override readonly name = 'HeldPayoutUnreadableError';
  readonly code = 'HELD_PAYOUT_UNREADABLE';

  constructor() {
    super('A held payout has no recipient, mandate or token total to route it by');
  }
}

/** A mandate instance on a contract version the router cannot address. */
export class UnsupportedSpecVersionError extends Error {
  override readonly name = 'UnsupportedSpecVersionError';
  readonly code = 'UNSUPPORTED_SPEC_VERSION';

  constructor() {
    super('The mandate instance is on an unsupported spec version');
  }
}

export function createRouteStores(options: RouteStoreOptions): RouteStores {
  const { db, networkOf, railOf, attemptDeadline, holdTargets } = options;

  const refOf = (row: {
    readonly chain: string;
    readonly contractAddress: string;
    readonly specVersion: string;
  }): MandateRef => {
    if (row.specVersion !== '1') throw new UnsupportedSpecVersionError();
    const network = networkOf(row.chain);
    return { network, address: { network, value: row.contractAddress }, specVersion: 1 };
  };

  const holds: FundingHoldStore = {
    async hold(scope, payoutId, total, shortfalls, opts) {
      opts.signal.throwIfAborted();
      return db.tenant(scope).transaction(async (tx) => {
        const held = await fundingHolds.hold(
          tx,
          payoutId,
          shortfalls.map((s) => ({
            mandateInstanceId: s.mandateInstanceId,
            network: s.network,
            needed: s.needed,
          })),
        );
        if (held) await routing.recordTotal(tx, payoutId, total);
        return held;
      });
    },

    heldPairs: (opts) => holdTargets(opts),

    async oldestHeld(target, limit, opts) {
      opts.signal.throwIfAborted();
      const rows = await db
        .principal({ principalId: target.principalId, projectId: target.projectId }, 'app')
        .transaction((tx) => routing.heldOnNetwork(tx, target.network, limit));
      return rows.map((row) => ({
        scope: { principalId: row.principalId as Uuid, projectId: row.projectId as Uuid },
        payoutId: row.payoutId as Uuid,
        network: row.network as NetworkId,
        mandateInstanceId: row.mandateInstanceId,
        needed: row.needed,
        heldAt: row.heldAt,
      }));
    },

    // All or nothing, in one transaction: the move, the attempt, and every hold row
    // of the payout on every network. If the attempt is refused, nothing moved.
    async release(scope, payoutId, route, opts) {
      opts.signal.throwIfAborted();
      return db.tenant(scope).transaction(async (tx) => {
        if (!(await routing.moveHeldToRouted(tx, payoutId, route.total))) return false;
        await payoutAttempts.create(tx, {
          payoutId,
          mandateInstanceId: route.mandateInstanceId,
          network: route.network,
          total: route.total,
          deadline: attemptDeadline(),
        });
        await fundingHolds.release(tx, payoutId);
        return true;
      });
    },

    async expire(scope, payoutId, opts) {
      opts.signal.throwIfAborted();
      return db.tenant(scope).transaction(async (tx) => {
        if (!(await routing.moveHeldToExpired(tx, payoutId))) return false;
        await fundingHolds.release(tx, payoutId);
        return true;
      });
    },

    async maxHoldSeconds(scope, opts) {
      opts.signal.throwIfAborted();
      const settings = await db.tenant(scope).transaction((tx) => projects.settings(tx));
      if (settings === undefined) throw new HeldPayoutUnreadableError();
      return settings.fundingHoldMaxSeconds;
    },

    async requestOf(scope, payoutId, opts) {
      opts.signal.throwIfAborted();
      return db.tenant(scope).transaction(async (tx): Promise<RouteRequest> => {
        const payout = await payouts.get(tx, payoutId);
        if (payout === undefined) throw new HeldPayoutUnreadableError();
        const recipient = await recipients.get(tx, payout.recipientId);
        const settings = await projects.settings(tx);
        const { requested } = payout;
        const total: TokenAmount | null =
          payout.total ?? (requested.kind === 'token' ? requested : null);
        if (recipient === undefined || settings === undefined || total === null) {
          throw new HeldPayoutUnreadableError();
        }
        return {
          scope,
          mandateId: payout.mandateId as Uuid,
          recipientId: payout.recipientId as Uuid,
          country: recipient.country,
          total,
          // One leg on the main method. Asked for in local currency, the corridor
          // must deliver that currency; asked for in the token, the corridor decides.
          legs: [
            {
              method: payout.method as PayoutMethodName,
              ...(requested.kind === 'fiat' ? { currency: requested.currency } : {}),
              amount: total,
            },
          ],
          chainFallback: settings.chainFallback,
          correlationId: payoutId,
        };
      });
    },

    async instanceOf(scope, mandateInstanceId, opts) {
      opts.signal.throwIfAborted();
      const row = await db
        .tenant(scope)
        .transaction((tx) => mandateInstances.get(tx, mandateInstanceId));
      if (row === undefined) throw new HeldPayoutUnreadableError();
      return { mandateInstanceId: row.id, ref: refOf(row) };
    },
  };

  const mandates: MandateInstances = {
    async list(scope, mandateId, opts) {
      opts.signal.throwIfAborted();
      const rows = await db
        .tenant(scope)
        .transaction((tx) => routing.instancesOfMandate(tx, mandateId));
      return rows.map((row) => ({ mandateInstanceId: row.id, ref: refOf(row) }));
    },

    async unrequested(scope, mandateInstanceId, zero, opts) {
      opts.signal.throwIfAborted();
      const amount = await db
        .tenant(scope)
        .transaction((tx) => routing.unrequestedOnInstance(tx, mandateInstanceId));
      if (!isTokenAsset(zero.asset)) throw new HeldPayoutUnreadableError();
      return tokenAmount(amount, zero.asset, zero.chain);
    },
  };

  const destinations: VerifiedDestinations = {
    async list(scope, recipientId, opts) {
      opts.signal.throwIfAborted();
      const rows = await db
        .tenant(scope)
        .transaction((tx) => routing.usableMethods(tx, recipientId));
      return rows.map((row) => ({
        recipientMethodId: row.id as Uuid,
        method: row.method as PayoutMethodName,
        network: networkOf(row.chain),
        rail: railOf(row.chain, row.rail),
      }));
    },
  };

  return { holds, mandates, destinations };
}
