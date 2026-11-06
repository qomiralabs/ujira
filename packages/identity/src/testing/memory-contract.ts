// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The in-memory stand-ins as a backend for the shared identity contract.

import type { TenantScope } from '@ujira/chain-adapter';

import { InMemoryAttestationLog, InMemoryPayoutLegs } from './attestation.js';
import type { ContractBackend, ContractSeed, ContractTenant } from './contract.js';
import {
  TEST_NOW,
  identityRow,
  legRow,
  mandateRow,
  methodRow,
  newScope,
  recipientRow,
  verificationRow,
} from './fixtures.js';
import { InMemoryIdentityStore } from './memory-store.js';
import { InMemoryProviderEventStore } from './self.js';

export function memoryContractBackend(): ContractBackend {
  const store = new InMemoryIdentityStore();
  const log = new InMemoryAttestationLog();
  const legs = new InMemoryPayoutLegs();
  const events = new InMemoryProviderEventStore();
  return {
    store,
    log,
    legs,
    events,
    seed(options: ContractSeed = {}): Promise<ContractTenant> {
      const scope = newScope();
      const instance = mandateRow(scope, {
        status: options.instanceStatus ?? 'active',
      });
      const recipient = recipientRow(scope, {
        status: options.recipientActive === false ? 'inactive' : 'active',
      });
      const method = methodRow(scope, recipient.id);
      const leg = legRow(instance, method);
      store.putMandateInstance(instance).putRecipient(recipient).putPayoutMethod(method);
      const kind = options.identity ?? 'verified';
      const identity =
        kind === 'none'
          ? null
          : identityRow(scope, recipient.id, {
              status: kind === 'pending' ? 'pending' : 'verified',
              expiresAt: kind === 'expired' ? ((TEST_NOW - 1n) as typeof TEST_NOW) : null,
            });
      if (identity !== null) store.putIdentity(identity);
      const verification = options.verified === false ? null : verificationRow(method);
      if (verification !== null) store.putVerification(verification);
      if (options.settings !== undefined && options.settings !== null) {
        store.putProjectSettings(scope, options.settings);
      }
      legs.put(leg);
      return Promise.resolve({
        scope,
        instanceId: instance.id,
        recipientId: recipient.id,
        methodId: method.id,
        identityId: identity?.id ?? null,
        verificationId: verification?.id ?? null,
        attemptId: leg.attemptId,
        legIndex: leg.legIndex,
        address: method.destination.address.value,
      });
    },
    isPending(message, attesterKeyId) {
      return Promise.resolve(log.isPending(message, attesterKeyId));
    },
    attestationStatuses(scope: TenantScope) {
      return Promise.resolve(log.rows(scope).map((row) => row.status));
    },
  };
}
