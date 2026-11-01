// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export { ATTESTATION_MESSAGE_BYTES, createAttestationService } from './attest.js';
export {
  MAX_ATTESTATION_VALIDITY_SECONDS,
  MIN_ATTESTATION_VALIDITY_SECONDS,
  identityConfigSchema,
  parseIdentityConfig,
  parseProjectIdentitySettings,
  projectIdentitySettingsSchema,
} from './config.js';
export type { IdentityConfig } from './config.js';
export {
  decideEligibility,
  effectiveRequirement,
  identityNeeds,
  identityRefusal,
} from './eligibility.js';
export type { EligibilityFacts, IdentityNeed } from './eligibility.js';
export {
  AttestationConflictError,
  AttestationMessageError,
  AttestationSigningError,
  AttestationStateError,
  CallAbortedError,
  CallTimeoutError,
  IDENTITY_ERROR_CODES,
  IdentityConfigError,
  IdentityError,
  IdentityInputError,
  IdentityTenantMismatchError,
  isIdentityError,
} from './errors.js';
export type { IdentityErrorCode } from './errors.js';
export { evidenceAccepted, sameDestination } from './evidence.js';
export type { AttestedMode } from './evidence.js';
export { canonicalCountryList, countryAllowed, countryPolicyHash } from './policy.js';
export { NOT_RECEIVABLE_REASONS, railCatalogFromRegistry } from './ports.js';
export type {
  AttestationChain,
  AttestationLog,
  AttestationServicePorts,
  CheckDestinationRequest,
  DestinationCheck,
  IdentityServicePorts,
  IdentityStore,
  NotReceivableReason,
  PayoutLegSource,
  ProofSignerState,
  RailCatalog,
} from './ports.js';
export { createIdentityService } from './service.js';
export {
  ASSURANCE_LEVELS,
  ATTESTATION_REFUSAL_REASONS,
  DEFAULT_RECIPIENT_REQUIREMENT,
  ELIGIBILITY_REFUSAL_REASONS,
  IDENTITY_PROVIDERS,
  IDENTITY_STATUSES,
  RECIPIENT_REQUIREMENTS,
  VERIFICATION_LEVELS,
} from './types.js';
export type * from './types.js';
