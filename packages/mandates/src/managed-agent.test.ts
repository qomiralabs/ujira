// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for managed agent keys on existing mandates (custody.ts).
 *
 * - assertMayAddManagedAgent reads the mode from the mandate's own config()
 *   and refuses attested with CustodyGuardError; allowlist and both pass.
 * - withCustodyGuard wraps a SignerProvider. For a managed_agent ref it
 *   looks up the modes of every mandate the key is seated on and refuses to
 *   sign with SignerDeniedError if any is attested. A lookup that fails or
 *   times out refuses with SignerUnavailableError. Other refs, address() and
 *   health() pass straight through.
 */

import { describe, expect, it, vi } from 'vitest';

import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type {
  CallOptions,
  SignPayload,
  SignerProvider,
  SignerRef,
  TenantScope,
  Uuid,
} from '@ujira/chain-adapter';

import { NETWORK, at, createOnChain, principalConfig, world } from '../test/world.js';
import {
  CustodyGuardError,
  assertMayAddManagedAgent,
  createMemoryManagedAgentMandates,
  withCustodyGuard,
} from './index.js';
import type { ManagedAgentMandates, RecipientMode } from './index.js';

const OPTS: CallOptions = { correlationId: 'corr-1' };
const SCOPE: TenantScope = { principalId: 'principal-1' as Uuid, projectId: 'project-1' as Uuid };
const OTHER_SCOPE: TenantScope = { ...SCOPE, principalId: 'principal-2' as Uuid };
const AGENT_ID = 'agent-1' as Uuid;
const MANAGED: SignerRef = {
  kind: 'managed_agent',
  network: NETWORK,
  scope: SCOPE,
  agentId: AGENT_ID,
};
const PAYLOAD: SignPayload = {
  kind: 'stellar_tx',
  network: NETWORK,
  xdr: 'AAAA',
} as unknown as SignPayload;
const SIGNATURE = { kind: 'ed25519', signature: new Uint8Array(64) };

const ENGINE_MODES: Readonly<Record<string, RecipientMode>> = {
  ALLOWLIST: 'allowlist',
  ATTESTED: 'attested',
  BOTH: 'both',
};

// The wrapped signer, with its sign mock kept apart so tests can assert on it.
function inner(): SignerProvider & { readonly signed: ReturnType<typeof vi.fn> } {
  const signed = vi.fn(() => Promise.resolve(SIGNATURE));
  return {
    signed,
    sign: signed,
    address: () => Promise.resolve(at('GADDRESS')),
    health: () =>
      Promise.resolve({ state: 'healthy', checkedAt: 0n, signP95Ms: null, reasons: [] }),
  } as unknown as SignerProvider & { readonly signed: ReturnType<typeof vi.fn> };
}

describe('managed-agent', () => {
  it('enabling a managed agent on an ATTESTED mandate is refused', () => {
    const mandate = createOnChain(
      world(),
      principalConfig({ recipientMode: 'attested', attester: new Uint8Array(32).fill(7) }),
    );
    const mode = ENGINE_MODES[mandate.config().recipientMode];
    if (mode === undefined) throw new Error('unknown engine mode');
    expect(() => {
      assertMayAddManagedAgent({ recipientMode: mode });
    }).toThrow(CustodyGuardError);
  });

  it.each(['allowlist', 'both'] as const)('enabling one on a %s mandate is allowed', (mode) => {
    expect(() => {
      assertMayAddManagedAgent({ recipientMode: mode });
    }).not.toThrow();
  });

  it('the signer refuses a managed agent key seated on an attested mandate', async () => {
    const seats = createMemoryManagedAgentMandates();
    seats.seat(SCOPE, AGENT_ID, 'allowlist');
    seats.seat(SCOPE, AGENT_ID, 'attested');
    const signer = inner();
    const guarded = withCustodyGuard(signer, { mandates: seats });
    await expect(guarded.sign(MANAGED, PAYLOAD, OPTS)).rejects.toThrow(SignerDeniedError);
    expect(signer.signed).not.toHaveBeenCalled();
  });

  it('the signer signs for a managed agent key on allowlist and both mandates only', async () => {
    const seats = createMemoryManagedAgentMandates();
    seats.seat(SCOPE, AGENT_ID, 'allowlist');
    seats.seat(SCOPE, AGENT_ID, 'both');
    // Another tenant's attested mandate with the same agent ID is not this key.
    seats.seat(OTHER_SCOPE, AGENT_ID, 'attested');
    const signer = inner();
    const guarded = withCustodyGuard(signer, { mandates: seats });
    await expect(guarded.sign(MANAGED, PAYLOAD, OPTS)).resolves.toBe(SIGNATURE);
    expect(signer.signed).toHaveBeenCalledWith(MANAGED, PAYLOAD, OPTS);
    // A key not seated on any mandate yet has nothing to break.
    const unseated: SignerRef = { ...MANAGED, agentId: 'agent-2' as Uuid };
    await expect(guarded.sign(unseated, PAYLOAD, OPTS)).resolves.toBe(SIGNATURE);
  });

  it('refuses when the lookup fails or hangs, never signing on an outage', async () => {
    const failing: ManagedAgentMandates = {
      recipientModesOf: () => Promise.reject(new Error('db down')),
    };
    const hanging: ManagedAgentMandates = { recipientModesOf: () => new Promise(() => undefined) };
    const signer = inner();
    await expect(
      withCustodyGuard(signer, { mandates: failing }).sign(MANAGED, PAYLOAD, OPTS),
    ).rejects.toThrow(SignerUnavailableError);
    await expect(
      withCustodyGuard(signer, { mandates: hanging, timeoutMs: 10 }).sign(MANAGED, PAYLOAD, OPTS),
    ).rejects.toThrow(SignerUnavailableError);
    expect(signer.signed).not.toHaveBeenCalled();
  });

  it('passes other keys, address and health straight through', async () => {
    const lookups = vi.fn(() => Promise.resolve<readonly RecipientMode[]>(['attested']));
    const signer = inner();
    const guarded = withCustodyGuard(signer, { mandates: { recipientModesOf: lookups } });
    const executor: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'alias/executor' };
    await expect(guarded.sign(executor, PAYLOAD, OPTS)).resolves.toBe(SIGNATURE);
    await expect(guarded.address(MANAGED, OPTS)).resolves.toEqual(at('GADDRESS'));
    await expect(guarded.health(OPTS)).resolves.toMatchObject({ state: 'healthy' });
    expect(lookups).not.toHaveBeenCalled();
  });
});
