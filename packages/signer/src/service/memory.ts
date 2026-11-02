// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// In-memory versions of the ports, for tests and for development until the
// tables they stand for exist. Empty, each one answers null, so a service
// wired to them refuses every request that needs a record.

import type { NetworkId } from '@ujira/chain-adapter';

import type {
  AttestationLog,
  IndexedMandate,
  MandateIndex,
  PendingAttestation,
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

export interface MemoryPendingAttestation extends PendingAttestation {
  readonly message: Uint8Array;
}

/** Empty, it refuses everything, which is how the service runs until the log exists. */
export function memoryAttestationLog(
  rows: readonly MemoryPendingAttestation[] = [],
): AttestationLog {
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
  return {
    pending: (message) => {
      const row = rows.find((r) => hex(r.message) === hex(message));
      return Promise.resolve(
        row === undefined
          ? null
          : {
              principalId: row.principalId,
              projectId: row.projectId,
              attestationId: row.attestationId,
            },
      );
    },
  };
}
