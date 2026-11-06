// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Who may call this deployment and how often, from its settings. A key works in
// one environment only: test keys in the sandbox, live keys in production.
//
// With no database configured, a local run refuses every key, so only the public
// routes answer. Production refuses to start that way, because it would look up
// and running while serving nothing.

import { randomBytes } from 'node:crypto';

import { createDatabase, loadDatabaseConfig, rateLimits } from '@ujira/db';
import type { DatabaseEnvironment } from '@ujira/db';

import { refuseAllCredentials } from './auth.js';
import { createEmbedAuthenticator, refuseAllEmbedTokens } from './embed-auth.js';
import type { AuthenticateEmbed } from './embed-auth.js';
import type { Authenticate } from './auth.js';
import type { ApiConfig, DeploymentEnvironment } from './config.js';
import { ApiConfigError } from './errors.js';
import type { Logger } from './log.js';
import { databaseBucketStore, databaseEmbedStore, databaseTokenStore } from './postgres-stores.js';
import { startRateLimitPruning } from './rate-limit-pruning.js';
import {
  allowEveryAddress,
  allowEveryRequest,
  createAddressRateLimit,
  createRateLimit,
} from './rate-limit.js';
import type { AddressRateLimit, RateLimit } from './rate-limit.js';
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
  readonly addressRateLimit: AddressRateLimit;
  readonly close: () => Promise<void>;
}

export interface AccessEnvironment extends DatabaseEnvironment {
  /** 32 bytes as hex. Keys the digest of a client address in a bucket's key. */
  UJIRA_API_ADDRESS_HMAC_KEY?: string | undefined;
}

const ADDRESS_HMAC_KEY = /^[0-9a-f]{64}$/;

// Every instance has to hold the same key, or each keeps its own buckets and the
// limit is multiplied by the number of instances. So production has to be told it. A
// sandbox has one instance, and a key that dies with the process is the safest one.
function addressHmacKey(env: AccessEnvironment, config: ApiConfig): Uint8Array {
  const text = env.UJIRA_API_ADDRESS_HMAC_KEY;
  if (text === undefined) {
    if (config.environment === 'production') {
      throw new ApiConfigError('production needs UJIRA_API_ADDRESS_HMAC_KEY');
    }
    return randomBytes(32);
  }
  if (!ADDRESS_HMAC_KEY.test(text)) {
    throw new ApiConfigError('invalid API settings: UJIRA_API_ADDRESS_HMAC_KEY');
  }
  return Buffer.from(text, 'hex');
}

export function apiAccessFromEnv(
  config: ApiConfig,
  env: AccessEnvironment,
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
      addressRateLimit: allowEveryAddress,
      close: () => Promise.resolve(),
    };
  }
  const hmacKey = addressHmacKey(env, config);
  // Not an error, because a server facing the internet directly is right to trust
  // nothing. Behind a proxy it means every client shares the proxy's one bucket.
  if (config.environment === 'production' && config.trustedProxy === null) {
    logger.write({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'no_trusted_proxy',
    });
  }
  const db = createDatabase(loadDatabaseConfig(env));
  const pruning = startRateLimitPruning({
    prune: (maxRows) => db.unscoped((tx) => rateLimits.pruneRefilled(tx, maxRows)),
    logger,
  });
  const environment = KEY_ENVIRONMENT[config.environment];
  const store = databaseEmbedStore(db);
  const buckets = databaseBucketStore(db);
  return {
    authenticateEmbed: createEmbedAuthenticator({ store, environment }),
    embed: { store, environment },
    authenticate: createTokenAuthenticator({
      store: databaseTokenStore(db),
      environment: KEY_ENVIRONMENT[config.environment],
      embedOrigins: config.embedOrigins,
      logger,
    }),
    rateLimit: createRateLimit(buckets),
    addressRateLimit: createAddressRateLimit(buckets, hmacKey),
    close: async () => {
      await pruning.stop();
      await db.close();
    },
  };
}
