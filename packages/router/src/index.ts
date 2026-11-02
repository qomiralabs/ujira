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
export { STORE_TIMEOUT_MS } from './timeout.js';
