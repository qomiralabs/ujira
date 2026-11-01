// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The ports the adapter is handed, faked: a signer holding test keys, a
// sponsorship policy with counters in memory, and alerts that are recorded
// instead of paged. Each one reads the shared fault plan, so a test turns a
// signer outage or a sponsorship refusal on in one place.

import {
  InvalidInputError,
  SignerDeniedError,
  SignerUnavailableError,
  SponsorDeniedError,
} from '../errors.js';
import type { NetworkId } from '../networks.js';
import type {
  SignatureResult,
  SignerHealth,
  SignerProvider,
  SignerRef,
  SignPayload,
} from '../signer.js';
import type {
  AdapterAlerts,
  ChainAddress,
  NativeAmount,
  SponsoredIntent,
  SponsorshipPolicy,
  TenantScope,
  UnixSeconds,
} from '../types.js';

import { accountFromSeed } from './address.js';
import { ed25519PublicKey, ed25519Sign, utf8 } from './bytes.js';
import type { FakeFaults } from './faults.js';

function scopeKey(scope: TenantScope): string {
  return `${scope.principalId}/${scope.projectId}`;
}

/** The bytes a fake transaction signature covers. */
export function signedBytes(payload: SignPayload): Uint8Array {
  switch (payload.kind) {
    case 'stellar_tx':
    case 'stellar_fee_bump':
    case 'sep10_challenge':
      return utf8(payload.xdr);
    case 'stellar_auth_entry':
      return utf8(payload.entryXdr);
    case 'attestation':
      throw new InvalidInputError({ issues: ['payload.kind (unsupported)'] });
  }
}

/** Test keys behind the signer port. Seeds never leave it. */
export class FakeSigner implements SignerProvider {
  readonly #faults: FakeFaults;
  readonly #clock: () => UnixSeconds;
  readonly #keys = new Map<string, Uint8Array>();
  #signed = 0;

  constructor(faults: FakeFaults, clock: () => UnixSeconds) {
    this.#faults = faults;
    this.#clock = clock;
  }

  /** How many signatures were made, for tests that check nothing was signed. */
  get signatures(): number {
    return this.#signed;
  }

  addExecutorKey(network: NetworkId, keyId: string, seed: Uint8Array): void {
    this.#keys.set(`executor|${network}|${keyId}`, seed);
  }

  addFeeSponsorKey(network: NetworkId, seed: Uint8Array): void {
    this.#keys.set(`fee_sponsor|${network}`, seed);
  }

  /** An agent key a principal opted in to have UJIRA hold, for that tenant only. */
  addManagedAgentKey(
    network: NetworkId,
    scope: TenantScope,
    agentId: string,
    seed: Uint8Array,
  ): void {
    this.#keys.set(`managed_agent|${network}|${scopeKey(scope)}|${agentId}`, seed);
  }

  #seed(ref: SignerRef): Uint8Array {
    if (this.#faults.isSignerDown) throw new SignerUnavailableError({ network: ref.network });
    let key: string;
    switch (ref.kind) {
      case 'executor':
        key = `executor|${ref.network}|${ref.keyId}`;
        break;
      case 'fee_sponsor':
        key = `fee_sponsor|${ref.network}`;
        break;
      case 'managed_agent':
        key = `managed_agent|${ref.network}|${scopeKey(ref.scope)}|${ref.agentId}`;
        break;
      case 'sep10':
      case 'attester':
      case 'external':
        throw new SignerDeniedError({ network: ref.network });
    }
    const seed = this.#keys.get(key);
    if (seed === undefined) throw new SignerDeniedError({ network: ref.network });
    return seed;
  }

  sign(ref: SignerRef, payload: SignPayload): Promise<SignatureResult> {
    // Run inside a promise so every refusal arrives as a rejection.
    return Promise.resolve().then(() => {
      const seed = this.#seed(ref);
      if (payload.network !== ref.network) throw new SignerDeniedError({ network: ref.network });
      const signature = ed25519Sign(seed, signedBytes(payload));
      this.#signed += 1;
      return { kind: 'ed25519' as const, signature, publicKey: ed25519PublicKey(seed) };
    });
  }

  address(ref: SignerRef): Promise<ChainAddress> {
    return Promise.resolve().then(() => ({
      network: ref.network,
      value: accountFromSeed(this.#seed(ref)),
    }));
  }

  health(): Promise<SignerHealth> {
    const down = this.#faults.isSignerDown;
    return Promise.resolve({
      state: down ? 'down' : 'healthy',
      checkedAt: this.#clock(),
      signP95Ms: null,
      reasons: down ? ['UNREACHABLE'] : [],
    });
  }
}

export interface Reservation {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly reservationId: string;
  readonly intent: SponsoredIntent;
  readonly maxFee: NativeAmount;
  state: 'reserved' | 'settled' | 'released';
  actualFee: NativeAmount | null;
}

/** Sponsorship counters in memory, refusing everything while the fault is on. */
export class FakeSponsorship implements SponsorshipPolicy {
  readonly #faults: FakeFaults;
  readonly #reservations = new Map<string, Reservation>();

  constructor(faults: FakeFaults) {
    this.#faults = faults;
  }

  get reservations(): readonly Reservation[] {
    return [...this.#reservations.values()];
  }

  reserve(r: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    readonly reservationId: string;
    readonly intent: SponsoredIntent;
    readonly maxFee: NativeAmount;
  }): Promise<void> {
    if (this.#reservations.has(r.reservationId)) return Promise.resolve();
    if (this.#faults.isSponsorDenied) {
      return Promise.reject(new SponsorDeniedError({ network: r.network }));
    }
    this.#reservations.set(r.reservationId, { ...r, state: 'reserved', actualFee: null });
    return Promise.resolve();
  }

  settle(r: {
    readonly scope: TenantScope;
    readonly reservationId: string;
    readonly actualFee: NativeAmount;
  }): Promise<void> {
    const found = this.#find(r.scope, r.reservationId);
    if (found?.state === 'reserved') {
      found.state = 'settled';
      found.actualFee = r.actualFee;
    }
    return Promise.resolve();
  }

  release(r: { readonly scope: TenantScope; readonly reservationId: string }): Promise<void> {
    const found = this.#find(r.scope, r.reservationId);
    if (found?.state === 'reserved') found.state = 'released';
    return Promise.resolve();
  }

  #find(scope: TenantScope, id: string): Reservation | undefined {
    const found = this.#reservations.get(id);
    return found !== undefined && scopeKey(found.scope) === scopeKey(scope) ? found : undefined;
  }
}

export type RecordedAlert =
  | { readonly kind: 'lowBalance'; readonly event: Parameters<AdapterAlerts['lowBalance']>[0] }
  | { readonly kind: 'stuck'; readonly event: Parameters<AdapterAlerts['stuck']>[0] }
  | { readonly kind: 'divergence'; readonly event: Parameters<AdapterAlerts['divergence']>[0] };

export class FakeAlerts implements AdapterAlerts {
  readonly #alerts: RecordedAlert[] = [];

  get alerts(): readonly RecordedAlert[] {
    return this.#alerts;
  }

  lowBalance(event: Parameters<AdapterAlerts['lowBalance']>[0]): void {
    this.#alerts.push({ kind: 'lowBalance', event });
  }

  stuck(event: Parameters<AdapterAlerts['stuck']>[0]): void {
    this.#alerts.push({ kind: 'stuck', event });
  }

  divergence(event: Parameters<AdapterAlerts['divergence']>[0]): void {
    this.#alerts.push({ kind: 'divergence', event });
  }
}
