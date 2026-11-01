// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Uuid } from '@ujira/chain-adapter';

import { PolicyStoreError, PolicyStoreTimeoutError, isMandatePolicyError } from './errors.js';

/**
 * One logical mandate of one tenant: the record the principal sees, which
 * may have one chain instance or several over its life. Every policy record
 * is keyed by all three fields, so one tenant's record can never answer for
 * another's mandate, even one with the same ID.
 */
export interface LogicalMandateKey {
  readonly principalId: Uuid;
  readonly projectId: Uuid;
  readonly mandateId: Uuid;
}

/** The text form stores key their records by. */
export function keyText(key: LogicalMandateKey): string {
  return JSON.stringify([key.principalId, key.projectId, key.mandateId]);
}

export interface PortCallOptions {
  /** Aborted when the caller's deadline passes. */
  readonly signal: AbortSignal;
}

/** Default bound on one store call. */
export const PORT_TIMEOUT_MS = 5_000;

/**
 * Runs one port call under a deadline. The signal is aborted at the
 * deadline and the call is abandoned even if the port ignores it. Any other
 * failure comes back as PolicyStoreError with the original as cause.
 */
export async function callPort<T>(
  run: (opts: PortCallOptions) => Promise<T>,
  timeoutMs: number = PORT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PolicyStoreTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([run({ signal: controller.signal }), deadline]);
  } catch (err) {
    if (isMandatePolicyError(err)) throw err;
    throw new PolicyStoreError(err);
  } finally {
    clearTimeout(timer);
  }
}
