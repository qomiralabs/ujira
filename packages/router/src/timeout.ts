// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import {
  RoutingConfigStoreError,
  RoutingConfigStoreTimeoutError,
  isRoutingConfigError,
} from './errors.js';
import type { StoreCallOptions } from './store.js';

/** Default bound on one store call. */
export const STORE_TIMEOUT_MS = 5_000;

/**
 * Runs one store call under a deadline. The signal is aborted at the
 * deadline, and the call is abandoned even if the store ignores it, so a
 * hung connection can never hold a poll or an operator forever. Any other
 * failure comes back as RoutingConfigStoreError with the original as cause.
 */
export async function callStore<T>(
  run: (opts: StoreCallOptions) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RoutingConfigStoreTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([run({ signal: controller.signal }), deadline]);
  } catch (err) {
    if (isRoutingConfigError(err)) throw err;
    throw new RoutingConfigStoreError(err);
  } finally {
    clearTimeout(timer);
  }
}

/** A call that hit its deadline. The call was aborted and its answer is ignored. */
export class RouteDeadlineError extends Error {
  override readonly name = 'RouteDeadlineError';

  constructor() {
    super('The call did not answer before its deadline');
  }
}

export type DeadlineResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Runs one call under a deadline and returns its result or its failure, so a
 * caller can treat a slow network as a down one. The signal is aborted at the
 * deadline, and the call is abandoned even if it ignores the signal.
 */
export async function withinDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<DeadlineResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RouteDeadlineError());
    }, timeoutMs);
  });
  try {
    return { ok: true, value: await Promise.race([run(controller.signal), deadline]) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}
