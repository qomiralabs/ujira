// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Keeps a service's routing snapshot in step with the active version. Each
// poll reads the pointer; only when it moved is the version fetched, parsed
// and frozen, and only a fully built snapshot is swapped in, by one
// reference assignment. A reader that takes current() once per decision
// therefore sees one version from start to finish, never a mix.
//
// A version that fails validation, or a store that cannot be read, leaves
// the previous snapshot in place and raises an alert. Routing on a known
// good version beats routing on nothing.

import { parseRoutingConfig } from './config.js';
import type { RoutingConfig } from './config.js';
import {
  RoutingConfigInvalidError,
  RoutingConfigStoreError,
  RoutingConfigUnavailableError,
  RoutingConfigVersionNotFoundError,
  isRoutingConfigError,
} from './errors.js';
import type { RoutingConfigError, RoutingConfigErrorCode } from './errors.js';
import type { RoutingConfigStore } from './store.js';
import { STORE_TIMEOUT_MS, callStore } from './timeout.js';

export const POLL_INTERVAL_MS = 30_000;

export interface RoutingSnapshot {
  readonly version: number;
  readonly config: RoutingConfig;
  readonly loadedAt: Date;
}

/**
 * Where the reloader reports trouble. Implementations must not throw: an
 * alert that fails is reported by the alerting code itself.
 */
export interface RoutingConfigAlerts {
  /** The active version fails validation. Raised once each time the pointer moves to it. */
  invalidActiveVersion(e: {
    readonly version: number;
    readonly issues: readonly string[];
    readonly keptVersion: number | null;
  }): void;
  /** The store could not be read, or names no usable version. Raised on every failed poll. */
  loadFailed(e: {
    readonly code: RoutingConfigErrorCode;
    readonly keptVersion: number | null;
  }): void;
}

export type PollOutcome =
  | { readonly kind: 'applied'; readonly version: number; readonly previous: number | null }
  | { readonly kind: 'unchanged'; readonly version: number }
  | {
      readonly kind: 'rejected';
      readonly version: number;
      readonly error: RoutingConfigInvalidError;
      readonly kept: number | null;
    }
  | { readonly kind: 'failed'; readonly error: RoutingConfigError; readonly kept: number | null };

export interface RoutingConfigReloaderOptions {
  readonly store: RoutingConfigStore;
  readonly alerts: RoutingConfigAlerts;
  readonly pollIntervalMs?: number;
  /** Bound on each store call within a poll. */
  readonly storeTimeoutMs?: number;
  readonly now?: () => Date;
  /**
   * Receives a failure of a scheduled poll, which only a throwing alert
   * sink can cause. By default it is rethrown as an unhandled rejection, so
   * it is never lost; polling continues either way.
   */
  readonly onLoopError?: (err: unknown) => void;
}

export class RoutingConfigReloader {
  readonly #store: RoutingConfigStore;
  readonly #alerts: RoutingConfigAlerts;
  readonly #pollIntervalMs: number;
  readonly #storeTimeoutMs: number;
  readonly #now: () => Date;
  readonly #onLoopError: (err: unknown) => void;
  #snapshot: RoutingSnapshot | null = null;
  #rejected: { readonly version: number; readonly error: RoutingConfigInvalidError } | null = null;
  #inFlight: Promise<PollOutcome> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(options: RoutingConfigReloaderOptions) {
    this.#store = options.store;
    this.#alerts = options.alerts;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#storeTimeoutMs = options.storeTimeoutMs ?? STORE_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
    this.#onLoopError =
      options.onLoopError ??
      ((err: unknown) => {
        throw err;
      });
  }

  /**
   * The snapshot to route with. Take it once per decision and read
   * everything from it, rather than calling this again midway.
   */
  current(): RoutingSnapshot {
    if (this.#snapshot === null) throw new RoutingConfigUnavailableError();
    return this.#snapshot;
  }

  /**
   * Loads the active version once. Polls never overlap: a call made while
   * one is running gets that poll's outcome, so an older read can never
   * land after a newer one.
   */
  poll(): Promise<PollOutcome> {
    this.#inFlight ??= this.#pollOnce().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /**
   * Loads the active version, then polls on the interval. Throws when no
   * valid version could be loaded, because a service that cannot route
   * should not start.
   */
  async start(): Promise<RoutingSnapshot> {
    const outcome = await this.poll();
    if (this.#snapshot === null) {
      // Only a rejected or failed poll leaves no snapshot.
      throw (outcome as Extract<PollOutcome, { error: unknown }>).error;
    }
    if (!this.#running) {
      this.#running = true;
      this.#schedule();
    }
    return this.#snapshot;
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      void this.poll().then(
        () => {
          this.#schedule();
        },
        (err: unknown) => {
          this.#schedule();
          this.#onLoopError(err);
        },
      );
    }, this.#pollIntervalMs);
    // A pending poll should never keep a process alive on its own.
    this.#timer.unref();
  }

  async #pollOnce(): Promise<PollOutcome> {
    const kept = this.#snapshot?.version ?? null;
    let version: number | null = null;
    let config: RoutingConfig;
    try {
      version = await callStore(
        (opts) => this.#store.readActivePointer(opts),
        this.#storeTimeoutMs,
      );
      if (version === null) throw new RoutingConfigUnavailableError();
      if (version === kept) return { kind: 'unchanged', version };
      if (version === this.#rejected?.version) {
        return { kind: 'rejected', version, error: this.#rejected.error, kept };
      }
      const wanted = version;
      const record = await callStore(
        (opts) => this.#store.getVersion(wanted, opts),
        this.#storeTimeoutMs,
      );
      if (record === null) throw new RoutingConfigVersionNotFoundError();
      config = parseRoutingConfig(record.document);
    } catch (err) {
      if (err instanceof RoutingConfigInvalidError && version !== null) {
        this.#rejected = { version, error: err };
        this.#alerts.invalidActiveVersion({ version, issues: err.issues, keptVersion: kept });
        return { kind: 'rejected', version, error: err, kept };
      }
      const error = isRoutingConfigError(err) ? err : new RoutingConfigStoreError(err);
      this.#alerts.loadFailed({ code: error.code, keptVersion: kept });
      return { kind: 'failed', error, kept };
    }
    // The swap: one assignment of a snapshot that is already complete and frozen.
    this.#snapshot = Object.freeze({ version, config, loadedAt: this.#now() });
    this.#rejected = null;
    return { kind: 'applied', version, previous: kept };
  }
}
