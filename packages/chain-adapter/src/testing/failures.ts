// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a call to the fake chain can end in other than a result. A mandate
// refusal is a MandateRuleError carrying the spec code, exactly what the
// adapter raises for a real chain. Everything else here is the host's, not
// the mandate's, and is kept in its own classes so a test can never mistake
// a token's failure or a host trap for a mandate code: the Stellar asset
// contract's codes 10 to 12 would otherwise read as UNAUTHORIZED,
// ROLE_CONFLICT and ROLE_SET_FULL.

import { MandateRuleError } from '../errors.js';

// Re-exported so code one folder down reaches it without climbing two.
export { MandateRuleError };

import { MANDATE_ERRORS } from './spec.js';
import type { MandateErrorName } from './spec.js';

/** Base class of every failure the fake host raises itself. */
export abstract class FakeHostFailure extends Error {}

/**
 * The signer of a call is not the address the call must authorize. On
 * Stellar this is the host refusing require_auth, never a mandate code.
 */
export class HostAuthFailure extends FakeHostFailure {
  override readonly name = 'HostAuthFailure';
  constructor(
    readonly required: string,
    readonly signer: string,
  ) {
    super('the call is not authorized by the address it must be');
  }
}

/** A host function trapped, as a failed ed25519 verification does on Stellar. */
export class HostAbort extends FakeHostFailure {
  override readonly name = 'HostAbort';
  constructor(readonly hostError: 'Crypto.InvalidInput') {
    super(`the host aborted the call: ${hostError}`);
  }
}

/**
 * The call did not land, for a reason outside the mandate's rules, such as
 * a balance read the token could not answer. It is never TRANSFER_FAILED.
 */
export class TransportFailure extends FakeHostFailure {
  override readonly name = 'TransportFailure';
}

/** A contract already on the call stack was called again and the host refused it. */
export class NestedCallRefused extends FakeHostFailure {
  override readonly name = 'NestedCallRefused';
  constructor(readonly contract: string) {
    super('a contract already on the call stack cannot be called again');
  }
}

/** A token refused an operation of its own: a transfer, a mint or a clawback. */
export class TokenFailure extends FakeHostFailure {
  override readonly name = 'TokenFailure';
  constructor(
    readonly token: string,
    readonly reason: TokenFailureReason,
  ) {
    super(`the token refused the operation: ${reason}`);
  }
}

export type TokenFailureReason =
  | 'insufficient_balance'
  | 'not_authorized'
  | 'no_trustline'
  | 'invalid_amount'
  | 'settlement_move_refused'
  | 'callback_failed'
  | 'not_a_token';

/** The mandate refusal for a spec error name. */
export function refusal(name: MandateErrorName): MandateRuleError {
  return new MandateRuleError(MANDATE_ERRORS[name], name);
}
