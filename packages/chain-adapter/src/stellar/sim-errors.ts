// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turns a failed simulation into an adapter error. The host logs an error
// event for each contract a failure passes through, and the emitter matters:
// the token contract numbers its own errors from 10, which would read as
// UNAUTHORIZED, ROLE_CONFLICT or ROLE_SET_FULL if taken for the mandate's.
// So a contract error is a mandate rule only when the called contract itself
// raised it, and a contract error from any other contract, the token, is
// TRANSFER_FAILED.

import { Address, xdr } from '@stellar/stellar-sdk/base';

import { InternalError, MandateRuleError, SubmissionRejectedError } from '../errors.js';
import type { ChainAdapterError } from '../errors.js';
import type { NetworkId } from '../networks.js';
import { SPEC_ERRORS, TRANSFER_FAILED_CODE } from './spec-errors.js';

interface ContractErrorEvent {
  readonly emitter: string | null;
  readonly code: number;
}

function contractErrors(events: readonly string[]): ContractErrorEvent[] {
  const out: ContractErrorEvent[] = [];
  for (const raw of events) {
    let event: xdr.ContractEvent;
    try {
      event = xdr.DiagnosticEvent.fromXdr(raw, 'base64').event;
    } catch {
      // An event we cannot read tells us nothing; the rest still might.
      continue;
    }
    const [first, second] = event.body.v0.topics;
    if (
      first?.type === 'scvSymbol' &&
      first.sym.toString() === 'error' &&
      second?.type === 'scvError' &&
      second.error.type === 'sceContract'
    ) {
      const id = event.contractId;
      out.push({
        emitter: id === null ? null : Address.contract(id.value).toString(),
        code: second.error.contractCode,
      });
    }
  }
  return out;
}

/**
 * The error for a call to `target` that failed with these diagnostic events.
 * Anything that is neither a mandate rule nor a token failure, such as a host
 * authorization failure or a budget overrun, is a rejection: nothing landed.
 */
export function callFailure(
  network: NetworkId,
  target: string,
  events: readonly string[],
): ChainAdapterError {
  const found = contractErrors(events);
  if (found.some((e) => e.emitter !== null && e.emitter !== target)) {
    return new MandateRuleError(TRANSFER_FAILED_CODE, 'TRANSFER_FAILED', { network });
  }
  const own = found.find((e) => e.emitter === target);
  if (own === undefined) return new SubmissionRejectedError({ network });
  const name = SPEC_ERRORS.get(own.code);
  if (name === undefined) return new InternalError({ network });
  return new MandateRuleError(own.code, name, { network });
}
