// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Starting the server. Apart from the transport, the only output is one line on
// stderr when it cannot start, and that line never holds a value from the environment.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { McpConfigError, loadMcpConfig } from './config.js';
import { createMcpServer } from './server.js';

export interface RunOptions {
  readonly transport: Transport;
  readonly stderr: (line: string) => void;
}

/** The exit code to end with, or 0 once serving. A client closing the transport ends it. */
export async function runServer(
  env: Readonly<Record<string, string | undefined>>,
  options: RunOptions,
): Promise<number> {
  try {
    loadMcpConfig(env);
  } catch (error) {
    if (!(error instanceof McpConfigError)) throw error;
    options.stderr(`ujira-mcp: ${error.message}\n`);
    return 1;
  }
  await createMcpServer().connect(options.transport);
  return 0;
}
