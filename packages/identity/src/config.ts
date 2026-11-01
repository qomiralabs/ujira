// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The platform's identity configuration and a project's identity settings,
// both validated before use. A provider that is not configured is off, so a
// missing entry can only refuse a payout, never let one through.

import { z } from 'zod';

import { IdentityConfigError, issuesOf } from './errors.js';
import { DEFAULT_RECIPIENT_REQUIREMENT, RECIPIENT_REQUIREMENTS } from './types.js';
import type { ProjectIdentitySettings } from './types.js';

const providerSchema = z.strictObject({ enabled: z.boolean() });

const OFF = { enabled: false } as const;

/** The longest window the mandate accepts for an attestation, in seconds. */
export const MAX_ATTESTATION_VALIDITY_SECONDS = 86_400;
/** An attestation that would lapse sooner than this is refused rather than signed. */
export const MIN_ATTESTATION_VALIDITY_SECONDS = 60;

const ATTESTATION_DEFAULTS = { ttlSeconds: MAX_ATTESTATION_VALIDITY_SECONDS, callTimeoutMs: 5_000 };

export const identityConfigSchema = z.strictObject({
  /** identity.providers.<name>.enabled */
  providers: z
    .strictObject({
      self: providerSchema.default(OFF),
      sep12: providerSchema.default(OFF),
      principal: providerSchema.default(OFF),
    })
    .default({ self: OFF, sep12: OFF, principal: OFF }),
  attestation: z
    .strictObject({
      /** How long a signed attestation lasts, before the identity expiry caps it. */
      ttlSeconds: z
        .int()
        .min(MIN_ATTESTATION_VALIDITY_SECONDS)
        .max(MAX_ATTESTATION_VALIDITY_SECONDS)
        .default(ATTESTATION_DEFAULTS.ttlSeconds),
      /** Per call limit on every chain and attester call. */
      callTimeoutMs: z.int().min(100).max(60_000).default(ATTESTATION_DEFAULTS.callTimeoutMs),
    })
    .default(ATTESTATION_DEFAULTS),
});

export type IdentityConfig = z.output<typeof identityConfigSchema>;

/** Throws IdentityConfigError naming the bad fields, never their values. */
export function parseIdentityConfig(raw: unknown): IdentityConfig {
  const parsed = identityConfigSchema.safeParse(raw);
  if (!parsed.success) throw new IdentityConfigError(issuesOf(parsed.error));
  return parsed.data;
}

export const projectIdentitySettingsSchema = z.strictObject({
  /** identity.recipientRequirement */
  recipientRequirement: z.enum(RECIPIENT_REQUIREMENTS).default(DEFAULT_RECIPIENT_REQUIREMENT),
});

/** A project with no settings stored gets the default requirement. */
export function parseProjectIdentitySettings(raw: unknown): ProjectIdentitySettings {
  const parsed = projectIdentitySettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new IdentityConfigError(issuesOf(parsed.error));
  return parsed.data;
}
