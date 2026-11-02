// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/identity/testing: in-memory stand-ins for the identity tables and
// row builders. Test code only; nothing here reaches a database or a provider.

export {
  ANCHOR_RAIL,
  ManualClock,
  StaticRailCatalog,
  TEST_COUNTRIES,
  TEST_NETWORK,
  TEST_NOW,
  WALLET_RAIL,
  accountOf,
  bytes32Of,
  contractOf,
  country,
  identityRow,
  legRow,
  mandateRow,
  methodRow,
  newId,
  newScope,
  railCapability,
  recipientRow,
  seedOf,
  snapshotOf,
  verificationRow,
} from './fixtures.js';
export {
  FakeAttestationChain,
  InMemoryAttestationLog,
  InMemoryPayoutLegs,
  LocalAttester,
  TEST_ATTESTER_SEED,
} from './attestation.js';
export type { FakeFailure, LocalAttesterOptions } from './attestation.js';
export { InMemoryIdentityStore, tenantKey } from './memory-store.js';
export { ATTESTATION_BREAKERS, ATTESTATION_STEPS } from './breakers.js';
export type { AttestationStep, Breaker } from './breakers.js';
export { FakeSelfClient, FakeSelfProvider, InMemoryProviderEventStore } from './self.js';
export type { SelfDelivery, SelfEventFields, SelfOutcome } from './self.js';
export { RecordingAlerts, TEST_SELF_FLOW, selfWorld } from './self-world.js';
export type { SelfWorld, SelfWorldOptions } from './self-world.js';
export { WORLD_ANCHOR, attestationWorld } from './world.js';
export type { AttestationWorld, AttestationWorldOptions } from './world.js';
