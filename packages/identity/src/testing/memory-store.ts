// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// An in-memory IdentityStore for tests and for services built before the
// identity tables exist. Rows are keyed by tenant and id together, so a read
// under one tenant cannot reach another tenant's row whatever id it asks for,
// the same guarantee the repository layer gives with row level security.

import type { TenantScope, Uuid } from '@ujira/chain-adapter';

import { IdentityConflictError } from '../errors.js';
import type { IdentityStore, IdentityUpdate, IdentityWriteStore } from '../ports.js';
import type {
  DestinationVerificationRecord,
  IdentityRecord,
  MandateInstanceRecord,
  PayoutMethodRecord,
  RecipientRecord,
} from '../types.js';

export function tenantKey(scope: TenantScope): string {
  return `${scope.principalId}/${scope.projectId}`;
}

function rowKey(scope: TenantScope, id: string): string {
  return `${tenantKey(scope)}/${id}`;
}

export class InMemoryIdentityStore implements IdentityStore, IdentityWriteStore {
  readonly #recipients = new Map<string, RecipientRecord>();
  readonly #methods = new Map<string, PayoutMethodRecord>();
  readonly #instances = new Map<string, MandateInstanceRecord>();
  readonly #identities = new Map<string, IdentityRecord>();
  readonly #settings = new Map<string, unknown>();
  // Insertion order is recording order, as the append only table's is.
  readonly #verifications = new Map<string, DestinationVerificationRecord>();

  putRecipient(row: RecipientRecord): this {
    this.#recipients.set(rowKey(row.scope, row.id), row);
    return this;
  }

  putPayoutMethod(row: PayoutMethodRecord): this {
    this.#methods.set(rowKey(row.scope, row.id), row);
    return this;
  }

  putMandateInstance(row: MandateInstanceRecord): this {
    this.#instances.set(rowKey(row.scope, row.id), row);
    return this;
  }

  /**
   * Replaces the recipient's row for the same provider and account, as the
   * planned unique index allows only one.
   */
  putIdentity(row: IdentityRecord): this {
    for (const [key, existing] of this.#identities) {
      if (
        tenantKey(existing.scope) === tenantKey(row.scope) &&
        existing.recipientId === row.recipientId &&
        existing.provider === row.provider &&
        existing.providerAccount === row.providerAccount
      ) {
        this.#identities.delete(key);
      }
    }
    this.#identities.set(rowKey(row.scope, row.id), row);
    return this;
  }

  /** Stored as given, so a test can store settings the schema refuses. */
  putProjectSettings(scope: TenantScope, raw: unknown): this {
    this.#settings.set(tenantKey(scope), raw);
    return this;
  }

  /** Appends; the last one put for a method is its latest. */
  putVerification(row: DestinationVerificationRecord): this {
    this.#verifications.set(rowKey(row.scope, row.id), row);
    return this;
  }

  recipient(scope: TenantScope, recipientId: Uuid): Promise<RecipientRecord | null> {
    return Promise.resolve(this.#recipients.get(rowKey(scope, recipientId)) ?? null);
  }

  payoutMethod(scope: TenantScope, methodId: Uuid): Promise<PayoutMethodRecord | null> {
    return Promise.resolve(this.#methods.get(rowKey(scope, methodId)) ?? null);
  }

  mandateInstance(scope: TenantScope, instanceId: Uuid): Promise<MandateInstanceRecord | null> {
    return Promise.resolve(this.#instances.get(rowKey(scope, instanceId)) ?? null);
  }

  identities(scope: TenantScope, recipientId: Uuid): Promise<readonly IdentityRecord[]> {
    const tenant = tenantKey(scope);
    return Promise.resolve(
      [...this.#identities.values()].filter(
        (row) => tenantKey(row.scope) === tenant && row.recipientId === recipientId,
      ),
    );
  }

  projectSettings(scope: TenantScope): Promise<unknown> {
    return Promise.resolve(this.#settings.get(tenantKey(scope)) ?? null);
  }

  latestVerification(
    scope: TenantScope,
    methodId: Uuid,
  ): Promise<DestinationVerificationRecord | null> {
    const tenant = tenantKey(scope);
    const rows = [...this.#verifications.values()].filter(
      (row) => tenantKey(row.scope) === tenant && row.methodId === methodId,
    );
    return Promise.resolve(rows.at(-1) ?? null);
  }

  verification(
    scope: TenantScope,
    verificationId: Uuid,
  ): Promise<DestinationVerificationRecord | null> {
    return Promise.resolve(this.#verifications.get(rowKey(scope, verificationId)) ?? null);
  }

  identityById(identityId: Uuid): Promise<IdentityRecord | null> {
    for (const row of this.#identities.values()) {
      if (row.id === identityId) return Promise.resolve(row);
    }
    return Promise.resolve(null);
  }

  createIdentity(row: IdentityRecord): Promise<void> {
    for (const existing of this.#identities.values()) {
      if (
        tenantKey(existing.scope) === tenantKey(row.scope) &&
        existing.recipientId === row.recipientId &&
        existing.provider === row.provider &&
        existing.providerAccount === row.providerAccount
      ) {
        return Promise.reject(new IdentityConflictError());
      }
    }
    this.#identities.set(rowKey(row.scope, row.id), row);
    return Promise.resolve();
  }

  updateIdentity(
    scope: TenantScope,
    identityId: Uuid,
    patch: IdentityUpdate,
  ): Promise<IdentityRecord> {
    const key = rowKey(scope, identityId);
    const row = this.#identities.get(key);
    if (row === undefined) return Promise.reject(new IdentityConflictError());
    const next: IdentityRecord = { ...row, ...patch };
    if (next.status === 'verified' && next.nullifierHmac !== null) {
      for (const other of this.#identities.values()) {
        if (
          other.id !== next.id &&
          other.status === 'verified' &&
          other.scope.principalId === next.scope.principalId &&
          other.nullifierHmac === next.nullifierHmac
        ) {
          return Promise.reject(new IdentityConflictError());
        }
      }
    }
    this.#identities.set(key, next);
    return Promise.resolve(next);
  }

  verifiedByNullifier(principalId: Uuid, nullifierHmac: string): Promise<IdentityRecord | null> {
    for (const row of this.#identities.values()) {
      if (
        row.status === 'verified' &&
        row.scope.principalId === principalId &&
        row.nullifierHmac === nullifierHmac
      ) {
        return Promise.resolve(row);
      }
    }
    return Promise.resolve(null);
  }
}
