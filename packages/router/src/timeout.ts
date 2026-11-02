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
