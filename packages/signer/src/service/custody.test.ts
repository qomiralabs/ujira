// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the custody guard in the agent signer service (custody.ts).
 *
 * - Every signature by a managed agent key is checked against where the key is seated.
 *   A seat on a mandate that pays attested recipients only refuses it, and operations is
 *   told at error level.
 * - A lookup that fails or is slow refuses too, so an outage never opens the gate.
 * - One tenant's seats never decide another's key, and other keys are not looked up.
 */

import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type { NetworkId, SignerProvider, SignerRef, Uuid } from '@ujira/chain-adapter';
import { readFileSync } from 'node:fs';

import { CUSTODY_VECTORS } from '@ujira/mandates';
import { describe, expect, it, vi } from 'vitest';

import { guardAgentSigner } from './custody.js';
import { memorySignerLogger } from './log.js';
import type { ManagedAgentSeats, RecipientMode } from './ports.js';

const NETWORK = 'stellar:testnet' as NetworkId;
const OPTS = { correlationId: 'custody-test' };
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const OTHER_TENANT = { ...TENANT, projectId: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as Uuid };
const AGENT = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' as Uuid;
const PAYLOAD = { kind: 'stellar_tx', network: NETWORK, xdr: 'AAAA' } as never;

/** Seats by tenant and agent, as the database version reads them. */
function memorySeats(): ManagedAgentSeats & {
  seat(scope: typeof TENANT, agentId: Uuid, mode: RecipientMode): void;
} {
  const seats = new Map<string, RecipientMode[]>();
  const keyOf = (scope: { principalId: string; projectId: string }, agentId: string) =>
    JSON.stringify([scope.principalId, scope.projectId, agentId]);
  return {
    recipientModesOf: (scope, agentId) => Promise.resolve(seats.get(keyOf(scope, agentId)) ?? []),
    seat(scope, agentId, mode) {
      const key = keyOf(scope, agentId);
      seats.set(key, [...(seats.get(key) ?? []), mode]);
    },
  };
}

const agentRef = (scope = TENANT): SignerRef => ({
  kind: 'managed_agent',
  network: NETWORK,
  scope,
  agentId: AGENT,
});

function backend() {
  const sign = vi.fn(() => Promise.resolve({ signature: 'signed' }));
  const provider = { sign, address: vi.fn(), health: vi.fn() } as unknown as SignerProvider;
  return { provider, sign };
}

describe('the agent signer custody guard', () => {
  it('refuses a key seated on an attested only mandate, and tells operations', async () => {
    const seats = memorySeats();
    seats.seat(TENANT, AGENT, 'allowlist');
    seats.seat(TENANT, AGENT, 'attested');
    const logger = memorySignerLogger();
    const inner = backend();
    const signer = guardAgentSigner(inner.provider, { seats, logger });

    await expect(signer.sign(agentRef(), PAYLOAD, OPTS)).rejects.toBeInstanceOf(SignerDeniedError);

    expect(inner.sign).not.toHaveBeenCalled();
    expect(logger.records).toEqual([
      expect.objectContaining({
        level: 'error',
        event: 'custody_refused',
        requestId: OPTS.correlationId,
        refKind: 'managed_agent',
        network: NETWORK,
        principalId: TENANT.principalId,
        projectId: TENANT.projectId,
        errorCode: 'SIGNER_DENIED',
      }),
    ]);
  });

  it('signs when every seat binds the destination to the principal allowlist', async () => {
    const seats = memorySeats();
    seats.seat(TENANT, AGENT, 'allowlist');
    seats.seat(TENANT, AGENT, 'both');
    const inner = backend();
    const signer = guardAgentSigner(inner.provider, { seats, logger: memorySignerLogger() });
    await expect(signer.sign(agentRef(), PAYLOAD, OPTS)).resolves.toEqual({ signature: 'signed' });
    expect(inner.sign).toHaveBeenCalledTimes(1);
  });

  it('refuses when the lookup fails', async () => {
    const seats = { recipientModesOf: () => Promise.reject(new Error('database gone')) };
    const signer = guardAgentSigner(backend().provider, { seats, logger: memorySignerLogger() });
    await expect(signer.sign(agentRef(), PAYLOAD, OPTS)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it('refuses when the lookup is slow', async () => {
    const seats = { recipientModesOf: () => new Promise<never>(() => undefined) };
    const signer = guardAgentSigner(backend().provider, {
      seats,
      logger: memorySignerLogger(),
      timeoutMs: 20,
    });
    await expect(signer.sign(agentRef(), PAYLOAD, OPTS)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it("one tenant's seat never affects another", async () => {
    const seats = memorySeats();
    seats.seat(OTHER_TENANT, AGENT, 'attested');
    const signer = guardAgentSigner(backend().provider, { seats, logger: memorySignerLogger() });
    await expect(signer.sign(agentRef(TENANT), PAYLOAD, OPTS)).resolves.toEqual({
      signature: 'signed',
    });
    await expect(signer.sign(agentRef(OTHER_TENANT), PAYLOAD, OPTS)).rejects.toBeInstanceOf(
      SignerDeniedError,
    );
  });

  it('looks nothing up for a key that is not a managed agent', async () => {
    const recipientModesOf = vi.fn(() => Promise.resolve([]));
    const signer = guardAgentSigner(backend().provider, {
      seats: { recipientModesOf },
      logger: memorySignerLogger(),
    });
    await signer.sign({ kind: 'fee_sponsor', network: NETWORK }, PAYLOAD, OPTS);
    expect(recipientModesOf).not.toHaveBeenCalled();
  });
});

describe('the agent service without its seats', () => {
  it('is wired to refuse rather than find no seat', () => {
    // No seats known is not the same as no seats, so boot.ts refuses every agent
    // signature until the real store is passed in.
    const source = readFileSync(new URL('./boot.ts', import.meta.url), 'utf8');
    expect(source).toContain('stores.agentSeats ?? seatsNotConfigured');
    expect(source).toContain("role === 'agent'");
  });
});

describe('the shared custody cases', () => {
  // The same cases the mandates package's rule is held to.
  it.each(CUSTODY_VECTORS)('seats %j are allowed: $allowed', async ({ seats, allowed }) => {
    const store = memorySeats();
    for (const mode of seats) store.seat(TENANT, AGENT, mode);
    const signer = guardAgentSigner(backend().provider, {
      seats: store,
      logger: memorySignerLogger(),
    });
    const signing = signer.sign(agentRef(), PAYLOAD, OPTS);
    if (allowed) await expect(signing).resolves.toEqual({ signature: 'signed' });
    else await expect(signing).rejects.toBeInstanceOf(SignerDeniedError);
  });
});
