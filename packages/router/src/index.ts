// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export { activateRoutingConfig, publishRoutingConfig } from './admin.js';
export type { AdminOptions } from './admin.js';
export { ROUTING_SCHEMA_VERSION, ROUTING_STRATEGIES, parseRoutingConfig } from './config.js';
export type {
  CorridorCandidate,
  CorridorConfig,
  RailConfig,
  RoutingConfig,
  RoutingStrategy,
} from './config.js';
export {
  ROUTING_CONFIG_ERROR_CODES,
  RoutingConfigError,
  RoutingConfigInvalidError,
  RoutingConfigStoreError,
  RoutingConfigStoreTimeoutError,
  RoutingConfigUnavailableError,
  RoutingConfigVersionNotFoundError,
  isRoutingConfigError,
} from './errors.js';
export type { RoutingConfigErrorCode } from './errors.js';
export { POLL_INTERVAL_MS, RoutingConfigReloader } from './reload.js';
export type {
  PollOutcome,
  RoutingConfigAlerts,
  RoutingConfigReloaderOptions,
  RoutingSnapshot,
} from './reload.js';
export { createMemoryRoutingConfigStore } from './store.js';
export type {
  MemoryRoutingConfigStore,
  RoutingConfigStore,
  RoutingConfigVersionRecord,
  StoreCallOptions,
} from './store.js';
export {
  DEFAULT_FUNDING_HOLD_MAX_SECONDS,
  RELEASE_BATCH,
  RELEASE_TASK,
  SWEEP_INTERVAL_SECONDS,
  createMemoryFundingHoldStore,
  heldStatus,
  holdPayout,
  onDeposit,
  releaseJobSpec,
  runReleaseHeld,
  sweepFundingHolds,
} from './hold.js';
export type {
  FundingHoldStore,
  HeldPayout,
  HoldDeps,
  MemoryFundingHoldStore,
  MemoryPayout,
  ReleaseDeps,
  ReleaseJobSpec,
  ReleaseQueue,
  ReleaseSummary,
  ReleaseTarget,
  StoreOptions,
} from './hold.js';
export {
  QUOTE_DEADLINE_MS,
  ROUTE_READ_DEADLINE_MS,
  adapterRouteQuotes,
  compareQuotes,
  selectRoute,
} from './select.js';
export type {
  MandateInstance,
  MandateInstances,
  NetworkShortfall,
  PreviousAttempt,
  ProviderHealth,
  RouteDeps,
  RouteLeg,
  RouteOutcome,
  RouteQuoteRequest,
  RouteQuotes,
  RouteRequest,
  RoutedOutcome,
  SelectedLeg,
  UnavailableReason,
  VerifiedDestination,
  VerifiedDestinations,
} from './select.js';
export { RouteDeadlineError, STORE_TIMEOUT_MS, withinDeadline } from './timeout.js';
export type { DeadlineResult } from './timeout.js';
