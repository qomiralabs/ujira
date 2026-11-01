// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where the adapter keeps its own copy of every signing request it hands
// out, so a signed payload is checked against what was built and never
// trusted for what it says. A request is used at most once: the first valid
// signed payload claims it, and the same payload again gets the same answer.
// Production backs this with the database, in the tenant's transaction.

import type { NetworkId } from '../networks.js';
import type { MandateAction, PayoutId, SigningSummary, TenantScope, UnixSeconds } from '../types.js';

export interface StoredSigningRequest {
  readonly requestId: string;
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly op: MandateAction['op'];
  /** The mandate's C address; for create, the address it will be deployed at. */
  readonly mandate: string | null;
  readonly payoutId: PayoutId | null;
  /** The address that signs: a G principal's account or a C smart wallet. */
  readonly signer: string;
  readonly kind: 'stellar_transaction' | 'stellar_auth_entry';
  /** Exactly what was handed out: transaction XDR or unsigned auth entry XDR. */
  readonly payload: string;
  /** For an auth entry, the host function it authorizes, as base64 XDR. */
  readonly hostFunction: string | null;
  /** For a transaction, its sequence number. */
  readonly sequence: bigint | null;
  /** The most UJIRA expects to pay for it, in stroops. */
  readonly fee: bigint;
  readonly validUntil: UnixSeconds;
  readonly summary: SigningSummary;
}

export interface SigningRequestUse {
  readonly signed: string;
  /** Null until the envelope is built, so a crash in between reads as unknown. */
  readonly txHash: string | null;
}

export interface LoadedSigningRequest {
  readonly request: StoredSigningRequest;
  readonly use: SigningRequestUse | null;
}

export interface SigningRequestStore {
  save(request: StoredSigningRequest): Promise<void>;
  /** Null when there is no such request for this tenant. */
  load(scope: TenantScope, requestId: string): Promise<LoadedSigningRequest | null>;
  /**
   * Marks the request used by `signed`, atomically. Returns null when this
   * call claimed it, or the earlier use when another call got there first.
   */
  claim(scope: TenantScope, requestId: string, signed: string): Promise<SigningRequestUse | null>;
  setTxHash(scope: TenantScope, requestId: string, txHash: string): Promise<void>;
}

function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId;
}

/** For tests and local development. Not shared between processes. */
export function createMemorySigningRequestStore(): SigningRequestStore {
  const rows = new Map<string, { request: StoredSigningRequest; use: SigningRequestUse | null }>();
  const find = (scope: TenantScope, id: string) => {
    const row = rows.get(id);
    return row !== undefined && sameScope(row.request.scope, scope) ? row : undefined;
  };
  return {
    save(request) {
      if (rows.has(request.requestId)) {
        return Promise.reject(new Error('signing request id already used'));
      }
      rows.set(request.requestId, { request, use: null });
      return Promise.resolve();
    },
    load(scope, requestId) {
      const row = find(scope, requestId);
      return Promise.resolve(row === undefined ? null : { request: row.request, use: row.use });
    },
    claim(scope, requestId, signed) {
      const row = find(scope, requestId);
      if (row === undefined) return Promise.reject(new Error('no such signing request'));
      if (row.use !== null) return Promise.resolve(row.use);
      row.use = { signed, txHash: null };
      return Promise.resolve(null);
    },
    setTxHash(scope, requestId, txHash) {
      const row = find(scope, requestId);
      if (row?.use == null) return Promise.reject(new Error('signing request not claimed'));
      row.use = { signed: row.use.signed, txHash };
      return Promise.resolve();
    },
  };
}
