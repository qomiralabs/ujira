// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import { API_DEFAULTS } from './app.js';
import { ApiConfigError } from './errors.js';

const wholeNumber = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/, 'a whole number')
    .transform((text) => Number.parseInt(text, 10))
    .pipe(z.number().int().min(min).max(max))
    .default(fallback);

export type DeploymentEnvironment = 'sandbox' | 'production';

// Comma separated. Each must be exactly an origin, because a browser's Origin
// header is compared with it character for character.
const EmbedOrigins = z
  .string()
  .default('')
  .transform((text) =>
    text
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
  .pipe(
    z.array(
      z.string().refine((origin) => {
        try {
          return new URL(origin).origin === origin;
        } catch {
          return false;
        }
      }),
    ),
  );

const ApiEnvironment = z.object({
  UJIRA_API_PORT: wholeNumber(1, 65_535, 8080),
  // Loopback unless told otherwise, so a local run is never reachable from
  // the network by accident.
  UJIRA_API_HOST: z.string().min(1).max(255).default('127.0.0.1'),
  UJIRA_API_REQUEST_TIMEOUT_MS: wholeNumber(100, 60_000, API_DEFAULTS.requestTimeoutMs),
  UJIRA_API_BODY_LIMIT_BYTES: wholeNumber(1, 10_485_760, API_DEFAULTS.bodyLimitBytes),
  // Sandbox unless told otherwise, so a local run never accepts a live key.
  UJIRA_API_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  UJIRA_API_EMBED_ORIGINS: EmbedOrigins,
});

export interface ApiConfig {
  readonly port: number;
  readonly hostname: string;
  readonly requestTimeoutMs: number;
  readonly bodyLimitBytes: number;
  /** Decides which keys work here: test keys in the sandbox, live keys in production. */
  readonly environment: DeploymentEnvironment;
  /** Exact origins a browser may send a key from. Empty means none. */
  readonly embedOrigins: readonly string[];
}

/** Reads the API settings. A bad one fails naming the setting, never its value. */
export function loadApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const parsed = ApiEnvironment.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new ApiConfigError(`invalid API settings: ${names.join(', ')}`);
  }
  return {
    port: parsed.data.UJIRA_API_PORT,
    hostname: parsed.data.UJIRA_API_HOST,
    requestTimeoutMs: parsed.data.UJIRA_API_REQUEST_TIMEOUT_MS,
    bodyLimitBytes: parsed.data.UJIRA_API_BODY_LIMIT_BYTES,
    environment: parsed.data.UJIRA_API_ENVIRONMENT,
    embedOrigins: parsed.data.UJIRA_API_EMBED_ORIGINS,
  };
}
