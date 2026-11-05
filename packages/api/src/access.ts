// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Who may call this deployment and how often, from its settings. A key works in
// one environment only: test keys in the sandbox, live keys in production.
//
// With no database configured, a local run refuses every key, so only the public
// routes answer. Production refuses to start that way, because it would look up
// and running while serving nothing.

import { createDatabase, loadDatabaseConfig } from '@ujira/db';
import type { DatabaseEnvironment } from '@ujira/db';

import { refuseAllCredentials } from './auth.js';
import { createEmbedAuthenticator, refuseAllEmbedTokens } from './embed-auth.js';
import type { AuthenticateEmbed } from './embed-auth.js';
import type { Authenticate } from './auth.js';
import type { ApiConfig, DeploymentEnvironment } from './config.js';
import { ApiConfigError } from './errors.js';
import type { Logger } from './log.js';
import { databaseBucketStore, databaseEmbedStore, databaseTokenStore } from './postgres-stores.js';
import { allowEveryRequest, createRateLimit } from './rate-limit.js';
import type { RateLimit } from './rate-limit.js';
import { EMBED_NOT_CONFIGURED } from './routes/embed.js';
import type { EmbedDependencies } from './routes/embed.js';
import type { TokenEnvironment } from './token.js';
import { createTokenAuthenticator } from './token-auth.js';

export const KEY_ENVIRONMENT: Readonly<Record<DeploymentEnvironment, TokenEnvironment>> =
  Object.freeze({ sandbox: 'test', production: 'live' });

export interface ApiAccess {
  readonly authenticate: Authenticate;
  readonly authenticateEmbed: AuthenticateEmbed;
  readonly embed: EmbedDependencies;
  readonly rateLimit: RateLimit;
  readonly close: () => Promise<void>;
}

export function apiAccessFromEnv(
  config: ApiConfig,
  env: DatabaseEnvironment,
  logger: Logger,
): ApiAccess {
  if (env.UJIRA_DB_APP_URL === undefined) {
    if (config.environment === 'production') {
      throw new ApiConfigError('production needs a database: UJIRA_DB_APP_URL is not set');
    }
    return {
      authenticate: refuseAllCredentials,
      authenticateEmbed: refuseAllEmbedTokens,
      embed: EMBED_NOT_CONFIGURED,
      rateLimit: allowEveryRequest,
      close: () => Promise.resolve(),
    };
  }
  const db = createDatabase(loadDatabaseConfig(env));
  const environment = KEY_ENVIRONMENT[config.environment];
  const store = databaseEmbedStore(db);
  return {
    authenticateEmbed: createEmbedAuthenticator({ store, environment }),
    embed: { store, environment },
    authenticate: createTokenAuthenticator({
      store: databaseTokenStore(db),
      environment: KEY_ENVIRONMENT[config.environment],
      embedOrigins: config.embedOrigins,
      logger,
    }),
    rateLimit: createRateLimit(databaseBucketStore(db)),
    close: () => db.close(),
  };
}
