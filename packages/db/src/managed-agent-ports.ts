// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The custody guard's lookups, in Postgres. The mandates package owns the shapes, so only
// its types are imported. Each call is one transaction in the key's own tenant session.

import type { ManagedAgentKeys, ManagedAgentMandates } from '@ujira/mandates';

import type { Database } from './database.js';
import { managedAgents } from './repositories/managed-agents.js';

/** A seat on a mandate whose recipient mode is not known yet. The guard refuses on it. */
export class SeatRecipientModeUnknownError extends Error {
  override readonly name = 'SeatRecipientModeUnknownError';
  readonly code = 'SEAT_RECIPIENT_MODE_UNKNOWN';

  constructor() {
    super('A managed agent key is seated on a mandate whose recipient mode is not known');
  }
}

export interface ManagedAgentPorts {
  readonly mandates: ManagedAgentMandates;
  readonly keys: ManagedAgentKeys;
}

export function createManagedAgentPorts(options: {
  readonly db: Pick<Database, 'tenant'>;
}): ManagedAgentPorts {
  const { db } = options;
  return {
    mandates: {
      async recipientModesOf(scope, agentId, opts) {
        opts.signal.throwIfAborted();
        const seats = await db
          .tenant({ principalId: scope.principalId, projectId: scope.projectId })
          .transaction((tx) => managedAgents.seats(tx, agentId));
        // An unknown mode could be the one that is not allowed, so it is not guessed.
        return seats.map((seat) => {
          if (seat.recipientMode === null) throw new SeatRecipientModeUnknownError();
          return seat.recipientMode;
        });
      },
    },
    keys: {
      async isManaged(scope, agent, opts) {
        opts.signal.throwIfAborted();
        return db
          .tenant({ principalId: scope.principalId, projectId: scope.projectId })
          .transaction((tx) => managedAgents.isManaged(tx, agent.network, agent.value));
      },
    },
  };
}
