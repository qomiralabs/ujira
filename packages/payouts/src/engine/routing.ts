// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the router reads from the database. A mandate instance and a payout method name
// a chain, and the router works in networks, so these answer with the enabled network
// on that chain. One deployment runs one network per chain.

import { railKindOf, type ChainAdapterRegistry, type Uuid } from '@ujira/chain-adapter';
import { tokenAmount } from '@ujira/core';
import { payoutEngine, payoutMethods, type Database } from '@ujira/db';
import type { MandateInstances, VerifiedDestination, VerifiedDestinations } from '@ujira/router';

const METHODS_PER_RECIPIENT = 100;

export function databaseMandates(db: Database, adapters: ChainAdapterRegistry): MandateInstances {
  return {
    list: async (scope, mandateId) => {
      const rows = await db
        .tenant(scope)
        .transaction(async (tx) => payoutEngine.instancesOfMandate(tx, mandateId));
      return rows.flatMap((row) => {
        const adapter = adapters.list().find((a) => a.chain === row.chain);
        if (adapter === undefined) return [];
        return [
          {
            mandateInstanceId: row.id,
            ref: {
              network: adapter.network,
              address: adapter.parseAddress(row.contractAddress),
              specVersion: 1 as const,
            },
          },
        ];
      });
    },
    unrequested: async (scope, mandateInstanceId, zero) => {
      const raw = await db
        .tenant(scope)
        .transaction(async (tx) => payoutEngine.unrequestedOn(tx, mandateInstanceId));
      return tokenAmount(raw, zero.asset, zero.chain);
    },
  };
}

export function databaseDestinations(
  db: Database,
  adapters: ChainAdapterRegistry,
): VerifiedDestinations {
  return {
    list: async (scope, recipientId) => {
      const methods = await db
        .tenant(scope)
        .transaction(async (tx) =>
          payoutMethods.forRecipient(tx, recipientId, METHODS_PER_RECIPIENT),
        );
      return methods.flatMap((method): readonly VerifiedDestination[] => {
        if (method.status !== 'active') return [];
        const adapter = adapters.list().find((a) => a.chain === method.chain);
        if (adapter === undefined) return [];
        const rail = adapter
          .capabilities()
          .rails.find((candidate) => railKindOf(candidate.rail) === method.rail);
        if (rail === undefined) return [];
        return [
          {
            recipientMethodId: method.id as Uuid,
            method: method.method as VerifiedDestination['method'],
            network: adapter.network,
            rail: rail.rail,
          },
        ];
      });
    },
  };
}
