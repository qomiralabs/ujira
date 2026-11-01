// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One recipient, ready to be attested: an active attested mandate whose
// on-chain attester is the local attester, an active recipient with a
// verified identity, an active wallet method with a wallet signature proof,
// and leg 0 of an attempt paying it. Tests break one thing and attest.

import type { MandateSnapshot, UnixSeconds } from '@ujira/chain-adapter';

import { createAttestationService } from '../attest.js';
import { parseIdentityConfig } from '../config.js';
import type { IdentityConfig } from '../config.js';
import type {
  AttestRequest,
  AttestResult,
  IdentityContext,
  IdentityRecord,
  MandateInstanceRecord,
  PayoutMethodRecord,
  RecipientRecord,
} from '../types.js';

import {
  FakeAttestationChain,
  InMemoryAttestationLog,
  InMemoryPayoutLegs,
  LocalAttester,
} from './attestation.js';
import {
  ANCHOR_RAIL,
  ManualClock,
  StaticRailCatalog,
  TEST_NETWORK,
  WALLET_RAIL,
  identityRow,
  legRow,
  mandateRow,
  methodRow,
  newScope,
  railCapability,
  recipientRow,
  snapshotOf,
  verificationRow,
} from './fixtures.js';
import { InMemoryIdentityStore } from './memory-store.js';

export const WORLD_ANCHOR = 'anchor-one';

export interface AttestationWorldOptions {
  readonly mode?: 'attested' | 'both';
  /** Pay through a rail that needs the anchor's KYC, which the recipient also holds. */
  readonly kycRail?: boolean;
  /** Record the wallet signature proof for the method. On by default. */
  readonly verified?: boolean;
  readonly legIndex?: number;
}

const ALL_ON = {
  providers: { self: { enabled: true }, sep12: { enabled: true }, principal: { enabled: true } },
  // Short, so a hanging call fails a test quickly.
  attestation: { callTimeoutMs: 150 },
};

export function attestationWorld(options: AttestationWorldOptions = {}) {
  const scope = newScope();
  const ctx: IdentityContext = { scope, correlationId: 'trace-attest' };
  const store = new InMemoryIdentityStore();
  const log = new InMemoryAttestationLog();
  const legs = new InMemoryPayoutLegs();
  const clock = new ManualClock();
  const rails = new StaticRailCatalog()
    .put(TEST_NETWORK, railCapability(WALLET_RAIL))
    .put(TEST_NETWORK, railCapability(ANCHOR_RAIL, { requiresRecipientKyc: true }));
  let config: IdentityConfig = parseIdentityConfig(ALL_ON);

  const instance = mandateRow(scope, { recipientMode: options.mode ?? 'attested' });
  const recipient = recipientRow(scope);
  const method = methodRow(
    scope,
    recipient.id,
    options.kycRail === true ? { rail: ANCHOR_RAIL, anchorId: WORLD_ANCHOR } : {},
  );
  // The current rows, replaced as a test patches them so patches compose.
  const rows = {
    instance,
    recipient,
    method,
    identity: identityRow(scope, recipient.id),
    leg: legRow(instance, method, { legIndex: options.legIndex ?? 0 }),
  };
  const verification = verificationRow(rows.method);

  store
    .putMandateInstance(rows.instance)
    .putRecipient(rows.recipient)
    .putPayoutMethod(rows.method)
    .putIdentity(rows.identity);
  if (options.kycRail === true) {
    store.putIdentity(
      identityRow(scope, rows.recipient.id, {
        provider: 'sep12',
        providerAccount: WORLD_ANCHOR,
        assurance: 'anchor_kyc',
      }),
    );
  }
  if (options.verified !== false) store.putVerification(verification);
  legs.put(rows.leg);

  // The attester builds its message the way the chain does, and signs only
  // what the log holds as pending.
  const attester: LocalAttester = new LocalAttester({
    messageOf: (fields) => chain.attestationMessage(fields),
    isPending: (message, keyId) => log.isPending(message, keyId),
  });
  const chain = new FakeAttestationChain(snapshotOf(rows.instance, attester.publicKeyBytes));

  const service = createAttestationService({
    store,
    rails,
    clock,
    config: () => config,
    chain: () => chain,
    signer: attester,
    log,
    legs,
  });
  const request: AttestRequest = {
    attemptId: rows.leg.attemptId,
    legIndex: rows.leg.legIndex,
    mandateInstanceId: rows.instance.id,
    methodId: rows.method.id,
  };

  return {
    scope,
    ctx,
    store,
    log,
    legs,
    clock,
    rails,
    chain,
    attester,
    service,
    request,
    verification,
    rows,
    setConfig(raw: unknown): void {
      config = parseIdentityConfig({ ...ALL_ON, ...(raw as object) });
    },
    patchInstance(patch: Partial<MandateInstanceRecord>): void {
      rows.instance = { ...rows.instance, ...patch };
      store.putMandateInstance(rows.instance);
    },
    patchRecipient(patch: Partial<RecipientRecord>): void {
      rows.recipient = { ...rows.recipient, ...patch };
      store.putRecipient(rows.recipient);
    },
    patchMethod(patch: Partial<PayoutMethodRecord>): void {
      rows.method = { ...rows.method, ...patch };
      store.putPayoutMethod(rows.method);
    },
    patchIdentity(patch: Partial<IdentityRecord>): void {
      rows.identity = { ...rows.identity, ...patch };
      store.putIdentity(rows.identity);
    },
    patchSnapshot(change: (snapshot: MandateSnapshot) => MandateSnapshot): void {
      chain.snapshot = change(chain.snapshot);
    },
    now(): UnixSeconds {
      return clock.nowSeconds();
    },
    attest(): Promise<AttestResult> {
      return service.attest(ctx, request);
    },
  };
}

export type AttestationWorld = ReturnType<typeof attestationWorld>;
