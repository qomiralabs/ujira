// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// In-memory versions of the ports, for tests and for development until the
// tables they stand for exist. Empty, each one answers null, so a service
// wired to them refuses every request that needs a record.

import type { NetworkId, TenantScope } from '@ujira/chain-adapter';

import type {
  IndexedMandate,
  ManagedSigner,
  ManagedSignerStore,
  MandateIndex,
  PrincipalRateLimiter,
  SponsorshipLedger,
  SponsorshipReservation,
} from './ports.js';

export interface MemoryMandate extends IndexedMandate {
  readonly network: NetworkId;
  readonly contract: string;
  /** The accounts holding the executor role. */
  readonly executors: readonly string[];
}

export function memoryMandateIndex(mandates: readonly MemoryMandate[] = []): MandateIndex {
  const find = (network: NetworkId, contract: string) =>
    mandates.find((m) => m.network === network && m.contract === contract);
  const view = (m: MemoryMandate | undefined): IndexedMandate | null =>
    m === undefined ? null : { tenant: m.tenant, recipientMode: m.recipientMode };
  return {
    forExecutor: (network, contract, executor) => {
      const m = find(network, contract);
      return Promise.resolve(m?.executors.includes(executor) === true ? view(m) : null);
    },
    find: (network, contract) => Promise.resolve(view(find(network, contract))),
  };
}

export interface MemoryReservation extends SponsorshipReservation {
  readonly network: NetworkId;
  readonly txHash: Uint8Array;
}

export function memorySponsorshipLedger(
  reservations: readonly MemoryReservation[] = [],
): SponsorshipLedger {
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
  return {
    reserved: (network, txHash) => {
      const row = reservations.find((r) => r.network === network && hex(r.txHash) === hex(txHash));
      return Promise.resolve(
        row === undefined
          ? null
          : { intent: row.intent, tenant: row.tenant, maxFeeStroops: row.maxFeeStroops },
      );
    },
  };
}

export interface MemoryManagedSigner extends ManagedSigner {
  readonly network: NetworkId;
  readonly scope: TenantScope;
  readonly agentId: string;
}

export function memoryManagedSignerStore(
  signers: readonly MemoryManagedSigner[] = [],
): ManagedSignerStore {
  return {
    active: (network, scope, agentId) => {
      const row = signers.find(
        (s) =>
          s.network === network &&
          s.agentId === agentId &&
          s.scope.principalId === scope.principalId &&
          s.scope.projectId === scope.projectId,
      );
      return Promise.resolve(
        row === undefined
          ? null
          : { address: row.address, keyRef: row.keyRef, keyTags: row.keyTags },
      );
    },
  };
}

export interface MemoryRateLimit {
  readonly limit: number;
  readonly windowSeconds: bigint;
}

/** A fixed window count per principal, in this process only. */
export function memoryRateLimiter(options: MemoryRateLimit): PrincipalRateLimiter {
  const windows = new Map<string, { window: bigint; count: number }>();
  return {
    take: (principalId, now) => {
      const window = now / options.windowSeconds;
      const current = windows.get(principalId);
      const count = current?.window === window ? current.count + 1 : 1;
      windows.set(principalId, { window, count });
      return Promise.resolve(count <= options.limit);
    },
  };
}
