// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

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
export type { ApiConfig } from './config.js';
export {
  ADAPTER_ERROR_MAP,
  ApiConfigError,
  ApiError,
  DATABASE_ERROR_CLASSES,
  RETRY_AFTER_SECONDS,
  RouteRegistryError,
  toApiError,
} from './errors.js';
export type { ApiErrorOptions } from './errors.js';
export { errorNameOf, jsonLogger, memoryLogger, stdoutLogger } from './log.js';
export type { LogFields, LogLevel, LogRecord, Logger, RequestLog } from './log.js';
export { OPENAPI_PATH, buildOpenApiDocument, withOpenApiRoute } from './openapi.js';
export { contractRoute, definePublicRoute, defineTenantRoute, queryParser } from './route.js';
export type {
  Access,
  HttpMethod,
  QueryParse,
  RequestContext,
  Route,
  RouteInput,
  SuccessStatus,
  TenantRequestContext,
} from './route.js';
export { V1_ROUTES } from './routes/index.js';
export { startServer } from './serve.js';
export type { RunningServer, ServeOptions } from './serve.js';
