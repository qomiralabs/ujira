// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The stdio entry point: `node dist/main.js`. A `bin` and its shebang come with the
// decision to publish this package.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { runServer } from './run.js';

process.exitCode = await runServer(process.env, {
  transport: new StdioServerTransport(),
  stderr: (line) => {
    process.stderr.write(line);
  },
});
