// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the server needs from its environment. The key comes from here and nowhere
// else: no tool takes one, and nothing here ever prints a value it was given,
// because a person who pastes the wrong secret into this variable must not then
// find it in a log.

import { z } from 'zod';

// The API key format, kept in step with `packages/api/src/token.ts`. Checked in full
// so that a wallet secret or anything else pasted here is refused, not sent.
const API_KEY = /^ujk_(live|test)_[a-z2-7]{16}_[a-z2-7]{59}$/;

const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

const Environment = z.object({
  UJIRA_API_KEY: z.string().optional(),
  UJIRA_API_URL: z.string().optional(),
});

export class McpConfigError extends Error {
  override readonly name = 'McpConfigError';
}

export interface McpConfig {
  readonly apiKey: string;
  /** An origin only, such as https://api.ujira.co. */
  readonly apiUrl: string;
}

function parsedUrl(text: string): URL {
  try {
    return new URL(text);
  } catch {
    throw new McpConfigError('UJIRA_API_URL is not a valid URL');
  }
}

export function loadMcpConfig(env: Readonly<Record<string, string | undefined>>): McpConfig {
  const { UJIRA_API_KEY: apiKey, UJIRA_API_URL: apiUrl } = Environment.parse(env);
  if (apiKey === undefined || apiKey === '') {
    throw new McpConfigError('UJIRA_API_KEY is not set');
  }
  if (!API_KEY.test(apiKey)) {
    throw new McpConfigError(
      'UJIRA_API_KEY is not a UJIRA API key. This server takes an API key from the dashboard, ' +
        'and never a wallet secret, a seed or a private key',
    );
  }
  if (apiUrl === undefined || apiUrl === '') {
    throw new McpConfigError('UJIRA_API_URL is not set');
  }
  const url = parsedUrl(apiUrl);
  // Over plain http the key would cross the network readable by anyone on the way.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new McpConfigError('UJIRA_API_URL must use https, unless it is this machine');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new McpConfigError('UJIRA_API_URL must hold no credentials, query or fragment');
  }
  if (url.pathname !== '/')
    throw new McpConfigError('UJIRA_API_URL must be an origin, with no path');
  return Object.freeze({ apiKey, apiUrl: url.origin });
}
