// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Soroban refuses a call whose contract events outgrow the network's
// configured maximum with a resource limit result, the same result as for
// CPU or memory. Only the host's diagnostic message tells the two apart, and
// only the events case means "split the batch" rather than "find the bad
// item", so the Stellar simulation port reads it here.

const RESOURCE_LIMIT = 'InvokeHostFunctionResourceLimitExceeded';

const EVENTS_LIMIT_MESSAGES: readonly string[] = Object.freeze([
  'total events size exceeds network config maximum',
  'return value pushes events size above network config maximum',
]);

/** Whether a failed simulation is the contract events limit. */
export function isEventsLimitFailure(result: string, diagnostics: readonly string[]): boolean {
  return (
    result === RESOURCE_LIMIT &&
    diagnostics.some((line) => EVENTS_LIMIT_MESSAGES.some((message) => line.includes(message)))
  );
}
