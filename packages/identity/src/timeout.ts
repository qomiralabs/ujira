// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { CallAbortedError, CallTimeoutError } from './errors.js';

/**
 * Runs an external call with its own deadline as well as the caller's. The
 * call gets a signal that fires on either, and the promise settles when the
 * deadline passes even if the call ignores its signal, so a stuck RPC can
 * never hold an attestation open.
 */
export async function withTimeout<T>(
  ms: number,
  outer: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (outer?.aborted === true) throw new CallAbortedError({ cause: outer.reason });
  const controller = new AbortController();
  let cleanup = (): void => undefined;
  // Rejects when either deadline passes, and never settles otherwise, so the
  // call's own result or error wins the race untouched.
  const stopped = new Promise<never>((_resolve, reject) => {
    const fail = (error: Error): void => {
      cleanup();
      controller.abort(error);
      reject(error);
    };
    const onOuterAbort = (): void => {
      fail(new CallAbortedError({ cause: outer?.reason }));
    };
    const timer = setTimeout(() => {
      fail(new CallTimeoutError());
    }, ms);
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    cleanup = () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    };
  });
  try {
    return await Promise.race([run(controller.signal), stopped]);
  } finally {
    cleanup();
  }
}
