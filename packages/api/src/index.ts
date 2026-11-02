// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export { KEY_ENVIRONMENT, apiAccessFromEnv } from './access.js';
export type { ApiAccess } from './access.js';
export { API_DEFAULTS, createApp, newRequestId } from './app.js';
export type { ApiDependencies } from './app.js';
export { API_SCOPES, AuthenticatedTenantSchema, refuseAllCredentials } from './auth.js';
export type {
  ApiScope,
  AuthFailureCode,
  AuthResult,
  Authenticate,
  AuthenticatedTenant,
  CallOptions,
  Credentials,
  Tenant,
} from './auth.js';
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
  databaseBucketStore,
  databaseIdempotencyStore,
  databaseSecurityEvents,
  databaseTokenStore,
} from './postgres-stores.js';
export {
  RATE_LIMIT_DEFAULTS,
  allowEveryRequest,
  bucketKey,
  createRateLimit,
  rateLimitHeaders,
} from './rate-limit.js';
export type {
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
export {
  contractRoute,
  definePublicRoute,
  defineTenantRoute,
  defineWebhookRoute,
  queryParser,
  requiresIdempotencyKey,
  routeAccessProblems,
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
