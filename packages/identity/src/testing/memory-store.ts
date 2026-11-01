// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// An in-memory IdentityStore for tests and for services built before the
// identity tables exist. Rows are keyed by tenant and id together, so a read
// under one tenant cannot reach another tenant's row whatever id it asks for,
// the same guarantee the repository layer gives with row level security.

import type { TenantScope, Uuid } from '@ujira/chain-adapter';

import type { IdentityStore } from '../ports.js';
import type {
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

export class InMemoryIdentityStore implements IdentityStore {
  readonly #recipients = new Map<string, RecipientRecord>();
  readonly #methods = new Map<string, PayoutMethodRecord>();
  readonly #instances = new Map<string, MandateInstanceRecord>();
  readonly #identities = new Map<string, IdentityRecord>();
  readonly #settings = new Map<string, unknown>();

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
}
