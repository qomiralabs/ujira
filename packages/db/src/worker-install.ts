// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// CREATE on the database, for the length of the worker install and no longer. A role
// that can create schemas could put one in front of what another role resolves, so
// ujira_worker holds this only while the installer runs. Granting it takes the
// platform admin, whose connection is used for nothing else.

import pg from 'pg';

import type { DatabaseConfig } from './config.js';

const GRANT = `
  do $grant$
  begin
    execute format('grant create on database %I to ujira_worker', current_database());
  end
  $grant$
`;

const REVOKE = `
  do $revoke$
  begin
    execute format('revoke create on database %I from ujira_worker', current_database());
  end
  $revoke$
`;

export async function withWorkerInstallGrant<T>(
  adminUrl: string,
  config: Pick<DatabaseConfig, 'tlsOptions'>,
  work: () => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: adminUrl,
    ...(config.tlsOptions === undefined ? {} : { ssl: config.tlsOptions }),
  });
  await client.connect();
  try {
    await client.query(GRANT);
    try {
      return await work();
    } finally {
      // In a finally, so an install that fails half way cannot leave the grant behind.
      await client.query(REVOKE);
    }
  } finally {
    await client.end();
  }
}
