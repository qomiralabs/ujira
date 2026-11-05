// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { apiAccessFromEnv, KEY_ENVIRONMENT } from './access.js';
import type { ApiConfig } from './config.js';
import { ApiConfigError } from './errors.js';
import { memoryLogger } from './log.js';

const CONFIG: ApiConfig = {
  port: 8080,
  hostname: '127.0.0.1',
  requestTimeoutMs: 10_000,
  bodyLimitBytes: 1024,
  environment: 'sandbox',
  embedOrigins: [],
};

const CALL = { signal: new AbortController().signal, correlationId: 'req_test' };

// A reachable shape and nothing behind it: no connection opens until a query runs.
const DATABASE_ENV = {
  UJIRA_DB_TLS: 'off',
  UJIRA_DB_APP_URL: 'postgresql://app:pw@127.0.0.1:1/ujira',
  UJIRA_DB_WORKER_URL: 'postgresql://worker:pw@127.0.0.1:1/ujira',
  UJIRA_DB_READER_URL: 'postgresql://reader:pw@127.0.0.1:1/ujira',
  UJIRA_DB_MIGRATION_URL: 'postgresql://migrator:pw@127.0.0.1:1/ujira',
};

describe('which keys a deployment takes', () => {
  it('takes test keys in the sandbox and live keys in production', () => {
    expect(KEY_ENVIRONMENT).toEqual({ sandbox: 'test', production: 'live' });
  });
});

describe('apiAccessFromEnv', () => {
  it('refuses every key on a local run with no database', async () => {
    const access = apiAccessFromEnv(CONFIG, {}, memoryLogger());
    const result = await access.authenticate({ authorization: 'Bearer x', origin: null }, CALL);
    expect(result).toEqual({ ok: false, code: 'TOKEN_INVALID' });
    await access.close();
  });

  it('will not start production with no database', () => {
    expect(() =>
      apiAccessFromEnv({ ...CONFIG, environment: 'production' }, {}, memoryLogger()),
    ).toThrow(ApiConfigError);
  });

  it('uses the token authenticator when a database is configured', async () => {
    const access = apiAccessFromEnv(CONFIG, DATABASE_ENV, memoryLogger());
    // A malformed key is refused in memory, so this needs no server behind it.
    const result = await access.authenticate({ authorization: 'Bearer x', origin: null }, CALL);
    expect(result).toEqual({ ok: false, code: 'TOKEN_MALFORMED' });
    await access.close();
  });
});
