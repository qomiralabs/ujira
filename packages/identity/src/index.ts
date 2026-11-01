// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export {
  identityConfigSchema,
  parseIdentityConfig,
  parseProjectIdentitySettings,
  projectIdentitySettingsSchema,
} from './config.js';
export type { IdentityConfig } from './config.js';
export { captureDestination, captureProviderDestination } from './destination.js';
export type { CapturedDestination } from './destination.js';
export {
  decideEligibility,
  effectiveRequirement,
  identityNeeds,
  identityRefusal,
} from './eligibility.js';
export type { EligibilityFacts, IdentityNeed } from './eligibility.js';
export {
  IDENTITY_ERROR_CODES,
  IdentityConfigError,
  IdentityError,
  IdentityInputError,
  IdentityTenantMismatchError,
  isIdentityError,
} from './errors.js';
export type { IdentityErrorCode } from './errors.js';
export { railCatalogFromRegistry } from './ports.js';
export type { IdentityServicePorts, IdentityStore, RailCatalog } from './ports.js';
export { createIdentityService } from './service.js';
export {
  ASSURANCE_LEVELS,
  DEFAULT_RECIPIENT_REQUIREMENT,
  ELIGIBILITY_REFUSAL_REASONS,
  IDENTITY_PROVIDERS,
  IDENTITY_STATUSES,
  RECIPIENT_REQUIREMENTS,
} from './types.js';
export type * from './types.js';
