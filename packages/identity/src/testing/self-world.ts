// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One active recipient with a wallet method under an attested mandate, a
// fake Self that signs with a secret generated here, and the Self flow wired
// to in-memory stores. Tests start a session, deliver results and read the
// identity row back.

import { randomBytes } from 'node:crypto';

import type { TenantScope, Uuid } from '@ujira/chain-adapter';

import { parseIdentityConfig } from '../config.js';
import { createIdentityService } from '../service.js';
import { parseSelfConfig } from '../self/config.js';
import type { Deployment } from '../self/config.js';
import type { IdentityAlerts, SelfVerificationPorts } from '../self/ports.js';
import { createSelfVerification } from '../self/service.js';
import { hmacSelfWebhookVerifier } from '../self/signature.js';
import type { IdentityContext } from '../types.js';

import {
  ManualClock,
  StaticRailCatalog,
  TEST_NETWORK,
  WALLET_RAIL,
  mandateRow,
  methodRow,
  newScope,
  railCapability,
  recipientRow,
} from './fixtures.js';
import { InMemoryIdentityStore } from './memory-store.js';
import { FakeSelfClient, FakeSelfProvider, InMemoryProviderEventStore } from './self.js';
import type { SelfDelivery } from './self.js';

export const TEST_SELF_FLOW = Object.freeze({ flowId: 'flow_prekyc', flowVersion: '1' });

export interface SelfWorldOptions {
  /** Share one store, provider and key between worlds to test across principals. */
  readonly store?: InMemoryIdentityStore;
  readonly provider?: FakeSelfProvider;
  readonly nullifierKey?: Uint8Array;
  readonly deployment?: Deployment;
}

/** Alerts that keep what they were told. */
export class RecordingAlerts implements IdentityAlerts {
  readonly credits: Parameters<IdentityAlerts['selfCreditsExhausted']>[0][] = [];
  readonly duplicates: {
    readonly scope: TenantScope;
    readonly recipientId: Uuid;
    readonly existingRecipientId: Uuid;
  }[] = [];

  selfCreditsExhausted(e: Parameters<IdentityAlerts['selfCreditsExhausted']>[0]): void {
    this.credits.push(e);
  }

  duplicatePerson(e: Parameters<IdentityAlerts['duplicatePerson']>[0]): void {
    this.duplicates.push(e);
  }
}

export function selfWorld(options: SelfWorldOptions = {}) {
  const scope = newScope();
  const ctx: IdentityContext = { scope, correlationId: 'trace-self' };
  const store = options.store ?? new InMemoryIdentityStore();
  const clock = new ManualClock();
  const recipient = recipientRow(scope);
  const method = methodRow(scope, recipient.id);
  const instance = mandateRow(scope);
  store.putRecipient(recipient).putPayoutMethod(method).putMandateInstance(instance);

  const self = parseSelfConfig(TEST_SELF_FLOW);
  const provider =
    options.provider ?? new FakeSelfProvider({ ...TEST_SELF_FLOW, environment: self.environment });
  const events = new InMemoryProviderEventStore();
  const client = new FakeSelfClient(() => clock.nowSeconds());
  const alerts = new RecordingAlerts();
  const nullifierKey = options.nullifierKey ?? randomBytes(32);
  const config = parseIdentityConfig({
    providers: { self: { enabled: true }, sep12: { enabled: true }, principal: { enabled: true } },
  });
  const ports: SelfVerificationPorts = {
    store,
    events,
    client,
    verifier: hmacSelfWebhookVerifier([provider.secret], self.webhookToleranceSeconds),
    alerts,
    clock,
    config: () => config,
    self,
    deployment: options.deployment ?? 'test',
    // A made up key of the test kind; it reaches only the fake client.
    credentials: { apiKey: 'sk_test_fake', nullifierKey },
  };
  const service = createSelfVerification(ports);
  const identity = createIdentityService({
    store,
    rails: new StaticRailCatalog().put(TEST_NETWORK, railCapability(WALLET_RAIL)),
    clock,
    config: () => config,
  });

  return {
    scope,
    ctx,
    store,
    clock,
    recipient,
    method,
    instance,
    provider,
    events,
    client,
    alerts,
    nullifierKey,
    ports,
    service,
    webhook(delivery: SelfDelivery) {
      return service.handleWebhook({ ...delivery, correlationId: 'trace-webhook' });
    },
    eligibility() {
      return identity.eligibility(ctx, {
        recipientId: recipient.id,
        methodId: method.id,
        mandateInstanceId: instance.id,
      });
    },
  };
}

export type SelfWorld = ReturnType<typeof selfWorld>;
