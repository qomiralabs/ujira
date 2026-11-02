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
  IdentityConflictError,
  ProviderUnavailableError,
  SelfCreditsExhaustedError,
  SelfSessionRefusedError,
  IdentityConfigError,
  IdentityError,
  IdentityInputError,
  IdentityTenantMismatchError,
  isIdentityError,
} from './errors.js';
export type { IdentityErrorCode, SessionRefusal } from './errors.js';
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
  IdentityUpdate,
  IdentityWriteStore,
  NotReceivableReason,
  PayoutLegSource,
  ProofSignerState,
  RailCatalog,
} from './ports.js';
export {
  DEPLOYMENTS,
  SELF_ENVIRONMENTS,
  SELF_SESSION_TTL_SECONDS,
  SELF_VERIFICATION_VALIDITY_SECONDS,
  checkSelfApiKey,
  parseSelfConfig,
  selfConfigSchema,
  selfFlowRules,
} from './self/config.js';
export type { Deployment, SelfConfig, SelfEnvironment, SelfFlowRules } from './self/config.js';
export { selfWebhookSchema } from './self/ports.js';
export type {
  IdentityAlerts,
  ProviderEventRecord,
  ProviderEventStore,
  SelfClient,
  SelfCredentials,
  SelfSession,
  SelfSessionRequest,
  SelfVerificationPorts,
  SelfWebhook,
} from './self/ports.js';
export { createSelfVerification } from './self/service.js';
export type {
  SelfVerification,
  SelfWebhookRequest,
  SelfWebhookResponse,
  SelfWebhookResult,
  StartSelfSessionRequest,
  StartedSelfSession,
} from './self/service.js';
export { SELF_SIGNATURE_HEADER, hmacSelfWebhookVerifier, selfSignature } from './self/signature.js';
export type {
  SelfWebhookVerifier,
  SignatureCheck,
  SignatureFailure,
  WebhookHeaders,
} from './self/signature.js';
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
