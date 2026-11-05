// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Starting the server. Apart from the transport, the only output is a line on stderr
// when something is wrong, and that line never holds a value from the environment.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { createApiClient } from './client.js';
import type { ApiClient } from './client.js';
import { McpConfigError, loadMcpConfig } from './config.js';
import type { McpConfig } from './config.js';
import { createMcpServer } from './server.js';

export interface RunOptions {
  readonly transport: Transport;
  readonly stderr: (line: string) => void;
  /** Replaceable for tests. */
  readonly createClient?: (config: McpConfig) => ApiClient;
}

/** The exit code to end with, or 0 once serving. A client closing the transport ends it. */
export async function runServer(
  env: Readonly<Record<string, string | undefined>>,
  options: RunOptions,
): Promise<number> {
  let config: McpConfig;
  try {
    config = loadMcpConfig(env);
  } catch (error) {
    if (!(error instanceof McpConfigError)) throw error;
    options.stderr(`ujira-mcp: ${error.message}\n`);
    return 1;
  }
  const server = createMcpServer({
    client: (options.createClient ?? createApiClient)(config),
    onInternalError: (errorName) => {
      options.stderr(`ujira-mcp: internal error ${errorName}\n`);
    },
  });
  await server.connect(options.transport);
  return 0;
}
