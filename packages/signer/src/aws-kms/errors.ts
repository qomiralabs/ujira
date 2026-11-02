// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which vendor failures can pass by themselves and which never will. A
// disabled key or a refused role needs a person, so retrying only delays the
// alert; a throttle or an outage clears up, so the job is retried under the
// signer's rules. Anything not named here is treated as an outage: a retry
// is bounded and ends in the dead letter queue, where a person sees it.

import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type { NetworkId } from '@ujira/chain-adapter';

import { KmsCallError } from './client.js';

const DENIED: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'DisabledException',
  'IncorrectKeyException',
  'InvalidGrantTokenException',
  'InvalidKeyUsageException',
  'KMSInvalidStateException',
  'KeyUnavailableException',
  'NotFoundException',
]);

/** A machine code for health, for the failures an operator should see by name. */
const REASONS: Readonly<Record<string, string>> = Object.freeze({
  ThrottlingException: 'THROTTLED',
  LimitExceededException: 'THROTTLED',
  DisabledException: 'KEY_DISABLED',
  KMSInvalidStateException: 'KEY_DISABLED',
  AccessDeniedException: 'ACCESS_DENIED',
  NotFoundException: 'KEY_NOT_FOUND',
});

function errorNameOf(error: unknown): string {
  return error instanceof KmsCallError ? error.errorName : 'Unknown';
}

/** The health reason a failure should raise, or null when it has no name of its own. */
export function reasonOf(error: unknown): string | null {
  return REASONS[errorNameOf(error)] ?? null;
}

/** The port's error for a failed call. The vendor's message never crosses the port. */
export function portError(
  error: unknown,
  network?: NetworkId,
): SignerDeniedError | SignerUnavailableError {
  const options = network === undefined ? {} : { network };
  if (DENIED.has(errorNameOf(error))) return new SignerDeniedError(options);
  return new SignerUnavailableError(options);
}
