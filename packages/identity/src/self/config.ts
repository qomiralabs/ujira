// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Self Pre-KYC settings. There is one flow per Self environment, and its
// rules are fixed here rather than configured: an adult, OFAC screened,
// nothing revealed to UJIRA, high security, results to our backend. Only
// the excluded countries are set by the compliance lead.

import { z } from 'zod';

import { IdentityConfigError, issuesOf } from '../errors.js';

export const SELF_ENVIRONMENTS = Object.freeze(['test', 'live'] as const);
export type SelfEnvironment = (typeof SELF_ENVIRONMENTS)[number];

/** Where this process runs. Only production may use a live Self key. */
export const DEPLOYMENTS = Object.freeze(['development', 'test', 'staging', 'production'] as const);
export type Deployment = (typeof DEPLOYMENTS)[number];

/** How long a verified Self result counts, from the time Self completed it. */
export const SELF_VERIFICATION_VALIDITY_SECONDS = 365n * 86_400n;
export const SELF_SESSION_TTL_SECONDS = 1_800;

const countryCode = z.string().regex(/^[A-Z]{2}$/);

export const selfConfigSchema = z.strictObject({
  environment: z.enum(SELF_ENVIRONMENTS).default('test'),
  flowId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  flowVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  excludedCountries: z.array(countryCode).max(250).default([]),
  /** How far a webhook's signed time may be from ours before it is refused as a replay. */
  webhookToleranceSeconds: z.int().min(30).max(900).default(300),
  callTimeoutMs: z.int().min(100).max(60_000).default(5_000),
});

export type SelfConfig = z.output<typeof selfConfigSchema>;

export function parseSelfConfig(raw: unknown): SelfConfig {
  const parsed = selfConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IdentityConfigError(issuesOf(parsed.error).map((issue) => `self.${issue}`));
  }
  return parsed.data;
}

/** What the session asks Self to check. Fixed: these are the compliance rules. */
export interface SelfFlowRules {
  readonly minimumAge: 18;
  readonly ofac: true;
  readonly excludedCountries: readonly string[];
  readonly reveals: readonly [];
  readonly security: 'high';
  readonly mode: 'backend';
}

export function selfFlowRules(config: SelfConfig): SelfFlowRules {
  return {
    minimumAge: 18,
    ofac: true,
    excludedCountries: [...config.excludedCountries],
    reveals: [],
    security: 'high',
    mode: 'backend',
  };
}

/**
 * A test key never reaches production and a live key never leaves it, and
 * the key must match the environment the flow lives in. The issue names
 * fields only, never the key.
 */
export function checkSelfApiKey(
  apiKey: string,
  deployment: Deployment,
  environment: SelfEnvironment,
): void {
  const kind = apiKey.startsWith('sk_live_')
    ? 'live'
    : apiKey.startsWith('sk_test_')
      ? 'test'
      : null;
  if (kind === null) throw new IdentityConfigError(['self.apiKey (invalid_format)']);
  const allowed: SelfEnvironment = deployment === 'production' ? 'live' : 'test';
  if (kind !== allowed) throw new IdentityConfigError(['self.apiKey (wrong_deployment)']);
  if (kind !== environment) throw new IdentityConfigError(['self.environment (key_mismatch)']);
}
