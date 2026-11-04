// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/** How a deadline or the caller's abort is reported, in the terms of the call that hit it. */
export interface DeadlineFailures {
  timeout(): Error;
  aborted(reason: unknown): Error;
}

/**
 * Runs `call` with a signal that fires at the deadline or when the caller
 * aborts, and stops waiting at that moment even if the callee ignores the
 * signal. A late answer or failure from the callee is dropped by the race.
 */
export async function withDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
  failures: DeadlineFailures,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer === undefined ? timeout : AbortSignal.any([outer, timeout]);
  const reason = (): Error =>
    timeout.aborted ? failures.timeout() : failures.aborted(signal.reason);
  if (signal.aborted) throw reason();
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(reason());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => call(signal)), stopped]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
