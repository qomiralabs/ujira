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

export const identityConfigSchema = z.strictObject({
  /** identity.providers.<name>.enabled */
  providers: z
    .strictObject({
      self: providerSchema.default(OFF),
      sep12: providerSchema.default(OFF),
      principal: providerSchema.default(OFF),
    })
    .default({ self: OFF, sep12: OFF, principal: OFF }),
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
