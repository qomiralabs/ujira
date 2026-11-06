// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/chain-adapter/testing: the fake chain every service above the
// adapter is tested against. An in-memory ledger with test tokens, the
// mandate factory and the mandate itself, which behaves exactly as the
// mandate spec says and passes the shared contract vectors, and unsigned
// Stellar envelopes for any account a test names. Test code only; nothing
// here reaches a network.

export { createMemoryAccountLedger } from './account-ledger.js';
export type { MemoryAccountLedger } from './account-ledger.js';
export {
  accountAddress,
  accountFromSeed,
  accountKeyOf,
  addressXdr,
  contractAddress,
  deployedAddress,
  isAddress,
} from './address.js';
export {
  ATTESTATION_PREFIX,
  attestationFieldBytes,
  attestationMessage,
  attestationMessageOf,
  encodeAttestationFields,
  signAttestation,
} from './attestation.js';
export type { AttestationFieldBytes, AttestationSubject } from './attestation.js';
export { ed25519PublicKey, ed25519Sign, ed25519Verify, hexOf, isBytes32, sha256 } from './bytes.js';
export {
  act,
  deployMandate,
  describeChainAdapter,
  drive,
  finalReceipt,
  must,
  payRequest,
  refusalOf,
} from './conformance.js';
export type {
  AdapterHarness,
  AdapterHarnessFactory,
  ChainFaults,
  ConformanceOptions,
  PayOptions,
  SuiteMandate,
  SuiteMandateOptions,
} from './conformance.js';
export { MandateEngine } from './engine.js';
export { MemoryEventIntakeStore } from './event-intake-store.js';
export { FakeChainAdapter, signFakeRequest } from './fake-adapter.js';
export type { FakeChainAdapterOptions, FakeChainAdapterPorts } from './fake-adapter.js';
export {
  FAKE_GENESIS,
  FAKE_TX_FEE,
  FakeNetwork,
  PUBNET_PASSPHRASE,
  mandateTenantTag,
} from './fake-network.js';
export type {
  FakeDeposit,
  FakeNetworkOptions,
  FakeTx,
  StoredRequest,
  TestAccount,
} from './fake-network.js';
export { FakeAlerts, FakeSigner, FakeSponsorship } from './fake-ports.js';
export type { RecordedAlert, Reservation } from './fake-ports.js';
export {
  FakeAdapterStore,
  LIVE_SUBMISSION_STATES,
  STORE_RULES,
  SUBMISSION_TRANSITIONS,
  isLiveSubmission,
} from './fake-store.js';
export type {
  FakeAdapterStoreOptions,
  FakeExecutorAccount,
  StoreRule,
  SubmissionMove,
} from './fake-store.js';
export { FAKE_SCOPES, createFakeWorld, fakeAdapterHarness, fakeChainFaults } from './fake-world.js';
export type { FakeWorld, FakeWorldOptions } from './fake-world.js';
export { FakeFaults, SimulatedCrash } from './faults.js';
export type { AnchorScript, AnchorStep, CrashPoint, FaultRates, RandomFault } from './faults.js';
export { STORE_CHECKS, describeAdapterStore, runAdapterStoreChecks } from './store-contract.js';
export type {
  StoreCheck,
  StoreCheckResult,
  StoreHarness,
  StoreHarnessFactory,
} from './store-contract.js';
export type { MandateEngineInit } from './engine.js';
export { MandateFactory } from './factory.js';
export type { MandateFactoryOptions } from './factory.js';
export {
  FakeHostFailure,
  HostAbort,
  HostAuthFailure,
  NestedCallRefused,
  TokenFailure,
  TransportFailure,
} from './failures.js';
export type { TokenFailureReason } from './failures.js';
export { FakeLedger, TESTNET_PASSPHRASE } from './ledger.js';
export type { FakeLedgerOptions, LedgerContract, NestedViews } from './ledger.js';
export { InMemoryRentStore } from './rent-store.js';
export { feeCap } from './rules.js';
export * from './spec.js';
export {
  TEST_CONTRACT,
  TEST_DESTINATION,
  TEST_INNER_SOURCE,
  testAuthEntryXdr,
  testFeeBumpXdr,
  testInvokeXdr,
  testReserveSandwichXdr,
  testSep10ChallengeXdr,
  testTransactionXdr,
} from './stellar.js';
export type {
  SandwichStep,
  TestAuthEntryOptions,
  TestFeeBumpOptions,
  TestInvokeOptions,
  TestSandwichOptions,
  TestSep10Options,
  TestTransactionOptions,
} from './stellar.js';
export { createMemorySponsorshipLedger, describeSponsorshipLedger } from './sponsorship-ledger.js';
export type { SponsorshipLedgerHarness } from './sponsorship-ledger.js';
export { FakeToken } from './token.js';
export { FakeTtlLedger, MemoryTtlStepStore, RecordingTtlMetrics } from './ttl.js';
export type { FakeTtlCall } from './ttl.js';
export type {
  FakeTokenOptions,
  ReceivingState,
  TokenTransfer,
  TransferHook,
  TrustlineState,
} from './token.js';
export type * from './types.js';
