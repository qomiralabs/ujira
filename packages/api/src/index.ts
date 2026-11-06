// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export { KEY_ENVIRONMENT, apiAccessFromEnv } from './access.js';
export type { ApiAccess } from './access.js';
export { API_DEFAULTS, createApp, newRequestId } from './app.js';
export type { ApiDependencies } from './app.js';
export {
  API_KEY_DEFAULT_EXPIRY_DAYS,
  API_KEY_MAX_ACTIVE,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_MAX_OVERLAP_HOURS,
  API_KEY_PRESETS,
  createApiKeyEndpoints,
} from './api-key-service.js';
export type {
  ApiKeyEndpoints,
  ApiKeyPreset,
  ApiKeyRecords,
  ApiKeyServiceDeps,
  ApiKeyView,
  RotateOutcome,
  StoredApiKey,
} from './api-key-service.js';
export {
  API_KEY_WARNING_THRESHOLDS,
  WARNING_CLAIM_SECONDS,
  sendApiKeyExpiryWarnings,
} from './api-key-warnings.js';
export type {
  ApiKeyExpiryNotifier,
  ApiKeyExpiryWarning,
  ApiKeyWarningDeps,
  ApiKeyWarningRecords,
  SweepResult,
  WarnedKey,
  WarningTarget,
  WarningThreshold,
} from './api-key-warnings.js';
export {
  API_SCOPES,
  AuthenticatedMemberSchema,
  AuthenticatedTenantSchema,
  MEMBER_ROLES,
  STEP_UP_MAX_AGE_SECONDS,
  refuseAllCredentials,
  refuseAllMembers,
} from './auth.js';
export type {
  ApiScope,
  AuthFailureCode,
  AuthResult,
  Authenticate,
  AuthenticatedTenant,
  CallOptions,
  AuthenticatedMember,
  AuthenticateMember,
  Credentials,
  MemberAuthResult,
  MemberCredentials,
  MemberRole,
  Tenant,
} from './auth.js';
export { clientAddress, normalizeAddress } from './client-address.js';
export type { RequestOrigin, TrustedProxy } from './client-address.js';
export { loadApiConfig } from './config.js';
export type { ApiConfig, DeploymentEnvironment } from './config.js';
export {
  ADAPTER_ERROR_MAP,
  ApiConfigError,
  ApiError,
  DATABASE_ERROR_CLASSES,
  MANDATE_ERROR_MAP,
  RETRY_AFTER_SECONDS,
  RouteRegistryError,
  toApiError,
} from './errors.js';
export type { ApiErrorOptions } from './errors.js';
export {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_LEASE_SECONDS,
  idempotencyKeyOf,
  isFinalStatus,
  memoryIdempotencyStore,
  requestFingerprint,
} from './idempotency.js';
export type {
  FinishRequest,
  IdempotencyStore,
  Reservation,
  ReserveRequest,
} from './idempotency.js';
export { errorNameOf, jsonLogger, memoryLogger, stdoutLogger } from './log.js';
export type { LogFields, LogLevel, LogRecord, Logger, RequestLog } from './log.js';
export { OPENAPI_PATH, buildOpenApiDocument, withOpenApiRoute } from './openapi.js';
export {
  databaseApiKeyRecords,
  databaseApiKeyWarningRecords,
  databaseBucketStore,
  databaseIdempotencyStore,
  databaseMandateRecords,
  databasePayoutRecords,
  databaseRecipientRecords,
  databaseSecurityEvents,
  databaseTokenStore,
} from './postgres-stores.js';
export type { PayoutScheduler } from './postgres-stores.js';
export {
  ADDRESS_LIMIT_DEFAULTS,
  RATE_LIMIT_DEFAULTS,
  addressBucketKey,
  allowEveryAddress,
  allowEveryRequest,
  bucketKey,
  createAddressRateLimit,
  createRateLimit,
  rateLimitHeaders,
} from './rate-limit.js';
export type {
  AddressLimitGroup,
  AddressLimitSubject,
  AddressRateLimit,
  BucketRequest,
  BucketResult,
  BucketStore,
  RateLimit,
  RateLimitDecision,
  RateLimitGroup,
  RateLimitRule,
  RateLimitRules,
  RateLimitSubject,
} from './rate-limit.js';
export { MAX_FEE_CAP_BPS, SWEEP_GRACE_SECONDS, createMandateEndpoints } from './mandate-service.js';
export type {
  ChainDefaults,
  MandateRecords,
  MandateServiceDeps,
  NewStoredMandate,
  StoredMandate,
  TransferFix,
} from './mandate-service.js';
export { MANDATES_NOT_CONFIGURED, mandateRoutes } from './routes/mandates.js';
export type { MandateEndpoints } from './routes/mandates.js';
export { createPayoutEndpoints } from './payout-service.js';
export type {
  NewPayoutRequest,
  PayoutCreation,
  PayoutReceiptLinks,
  PayoutRecords,
  PayoutServiceDeps,
  RecipientNames,
} from './payout-service.js';
export type { PayoutReceiptLink } from './payout-wire.js';
export { PAYOUTS_NOT_CONFIGURED, payoutRoutes } from './routes/payouts.js';
export type { PayoutEndpoints } from './routes/payouts.js';
export { createRecipientEndpoints, recipientNames } from './recipient-service.js';
export type {
  EncryptedValue,
  PersonalDataCipher,
  RecipientRecords,
  RecipientServiceDeps,
  StoredMethod,
  StoredRecipient,
} from './recipient-service.js';
export {
  CreateMethodRequest,
  RECIPIENTS_NOT_CONFIGURED,
  recipientRoutes,
} from './routes/recipients.js';
export type { RecipientEndpoints } from './routes/recipients.js';
export {
  contractRoute,
  defineMemberRoute,
  definePublicRoute,
  defineTenantRoute,
  defineWebhookRoute,
  queryParser,
  requiresIdempotencyKey,
  routeAccessProblems,
  storedResponseProblems,
} from './route.js';
export type {
  Access,
  HttpMethod,
  QueryParse,
  RequestContext,
  Route,
  RouteInput,
  SuccessStatus,
  TenantRequestContext,
  WebhookInput,
} from './route.js';
export {
  API_KEYS_NOT_CONFIGURED,
  ApiKeyIssued,
  ApiKeyRotated,
  ApiKeyView as ApiKeyViewSchema,
  CreateApiKeyRequest,
  RotateApiKeyRequest,
  apiKeyRoutes,
} from './routes/api-keys.js';
export { V1_ROUTES, v1Routes } from './routes/index.js';
export type { RouteDependencies } from './routes/index.js';
export {
  SELF_WEBHOOK_NOT_CONFIGURED,
  SELF_WEBHOOK_PATH,
  selfWebhookRoute,
} from './routes/self-webhook.js';
export type { SelfWebhookHandler } from './routes/self-webhook.js';
export {
  WALLET_CHALLENGES_PATH,
  WALLET_PROOFS_PATH,
  WALLET_PROOF_NOT_CONFIGURED,
  walletChallengeRoute,
  walletProofRoute,
} from './routes/wallet-proofs.js';
export { startServer } from './serve.js';
export { formatToken, hashSecret, issueToken, parseToken } from './token.js';
export type { IssuedToken, ParsedToken, TokenEnvironment } from './token.js';
export {
  TOKEN_CACHE_MAX_TTL_MS,
  TokenRecordError,
  createTokenAuthenticator,
} from './token-auth.js';
export type {
  SecurityEventSink,
  TokenAuthOptions,
  TokenLookup,
  TokenSecurityEvent,
  TokenStore,
} from './token-auth.js';
export type { RunningServer, ServeOptions } from './serve.js';
