// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/chain-adapter/testing: the fake chain every service above the
// adapter is tested against. An in-memory ledger with test tokens, the
// mandate factory and the mandate itself, which behaves exactly as the
// mandate spec says and passes the shared contract vectors, and unsigned
// Stellar envelopes for any account a test names. Test code only; nothing
// here reaches a network.

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
export { MandateEngine } from './engine.js';
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
export { FakeToken } from './token.js';
export type {
  FakeTokenOptions,
  ReceivingState,
  TokenTransfer,
  TransferHook,
  TrustlineState,
} from './token.js';
export type * from './types.js';
