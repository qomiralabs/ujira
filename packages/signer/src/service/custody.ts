// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// UJIRA also runs the attester. A key UJIRA holds that sits on a mandate paying attested
// recipients only could request a payout to an address UJIRA itself vouches for, so one
// compromise of the signing path could send funds anywhere. A principal can seat such a key
// straight on the contract, where nothing off chain sees it happen, so this is checked
// again on every signature, inside the service, where no caller can step around it.
//
// The rule is the one the mandates package applies at creation. It is written out here
// rather than imported, because the signer ships only what it must load to sign.

import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type { CallOptions, SignerProvider, SignerRef } from '@ujira/chain-adapter';

import { writeLog } from './log.js';
import type { SignerLogger } from './log.js';
import type { ManagedAgentSeats, RecipientMode } from './ports.js';

/** Long enough for one indexed read, short enough that a signature never waits on an outage. */
export const SEAT_LOOKUP_TIMEOUT_MS = 2_000;

// Where the principal's own allowlist always binds the destination.
const MODES_FOR_MANAGED_AGENTS: ReadonlySet<RecipientMode> = new Set(['allowlist', 'both']);

export interface AgentCustodyOptions {
  readonly seats: ManagedAgentSeats;
  readonly logger: SignerLogger;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

class SeatLookupTimeoutError extends Error {
  override readonly name = 'SeatLookupTimeoutError';

  constructor() {
    super('the seat lookup took too long');
  }
}

async function modesOf(
  seats: ManagedAgentSeats,
  ref: Extract<SignerRef, { kind: 'managed_agent' }>,
  timeoutMs: number,
): Promise<readonly RecipientMode[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SeatLookupTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      seats.recipientModesOf(ref.scope, ref.agentId, { signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The agent service's backend, refusing a managed key while it is seated on an attested
 * only mandate. The check is per key, not per payload: a key on one such mandate is
 * refused everywhere, because a payload alone does not prove which mandate it acts on. A
 * lookup that fails or is slow refuses too, so an outage never opens the gate. A refusal
 * is logged at error level, because it means a key UJIRA holds was seated where it must
 * never be, and operations has to take it off.
 */
export function guardAgentSigner(
  backend: SignerProvider,
  options: AgentCustodyOptions,
): SignerProvider {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? SEAT_LOOKUP_TIMEOUT_MS;

  const guard = async (ref: SignerRef, opts: CallOptions): Promise<void> => {
    if (ref.kind !== 'managed_agent') return;
    let modes: readonly RecipientMode[];
    try {
      modes = await modesOf(options.seats, ref, timeoutMs);
    } catch (cause) {
      throw new SignerUnavailableError({ network: ref.network, cause });
    }
    if (modes.every((mode) => MODES_FOR_MANAGED_AGENTS.has(mode))) return;
    writeLog(options.logger, 'error', 'custody_refused', opts.correlationId, now(), {
      refKind: ref.kind,
      network: ref.network,
      principalId: ref.scope.principalId,
      projectId: ref.scope.projectId,
      errorCode: 'SIGNER_DENIED',
    });
    throw new SignerDeniedError({ network: ref.network });
  };

  return {
    async sign(ref, payload, opts) {
      await guard(ref, opts);
      return backend.sign(ref, payload, opts);
    },
    address: (ref, opts) => backend.address(ref, opts),
    health: (opts) => backend.health(opts),
  };
}
