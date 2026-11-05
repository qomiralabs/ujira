// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The compliance store, in Postgres. The mandates package owns the shape, so only its
// types are imported. Each call is one transaction in the instance's own tenant session.

import type { ComplianceStore, InstanceKey } from '@ujira/mandates';

import type { Database } from './database.js';
import { compliance } from './repositories/compliance.js';

export interface ComplianceStoreOptions {
  readonly db: Pick<Database, 'tenant'>;
}

function sessionOf(db: ComplianceStoreOptions['db'], key: InstanceKey) {
  return db.tenant({ principalId: key.principalId, projectId: key.projectId });
}

export function createComplianceStore(options: ComplianceStoreOptions): ComplianceStore {
  const { db } = options;
  return {
    async read(key, opts) {
      opts.signal.throwIfAborted();
      const mark = await sessionOf(db, key).transaction((tx) =>
        compliance.mark(tx, key.instanceId),
      );
      return mark === undefined ? null : { reason: mark.reason, since: mark.since };
    },

    async applyMark(key, mark, notice, opts) {
      opts.signal.throwIfAborted();
      return sessionOf(db, key).transaction((tx) =>
        compliance.applyMark(tx, key.instanceId, mark, {
          to: notice.to,
          at: notice.at,
          fixes: notice.fixes,
        }),
      );
    },

    async parkIfNoncompliant(key, jobId, opts) {
      opts.signal.throwIfAborted();
      return sessionOf(db, key).transaction((tx) =>
        compliance.parkIfNoncompliant(tx, key.instanceId, jobId),
      );
    },
  };
}
