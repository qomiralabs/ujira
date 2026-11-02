// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/signer/service: the shared signer image. Each deployment serves a
// few ref kinds under its own policy and its own caller tokens; callers
// reach it through RemoteSigner from @ujira/signer and never load this.

export { AGENT_FUNCTIONS, agentPolicy } from './agent-policy.js';
export type { AgentPolicyOptions } from './agent-policy.js';
export { MAX_ATTESTATION_VALIDITY_SECONDS, attestPolicy } from './attest-policy.js';
export type { AttestPolicyOptions } from './attest-policy.js';
export { tokenAuthenticator } from './auth.js';
export type { Authenticate, ServiceCaller } from './auth.js';
export {
  EXECUTOR_FUNCTIONS,
  MAX_CHALLENGE_VALIDITY_SECONDS,
  MAX_SANDWICH_VALIDITY_SECONDS,
  chainPolicy,
} from './chain-policy.js';
export type { ChainNetworkPolicy, ChainPolicyOptions, Sep10Anchor } from './chain-policy.js';
export { SIGNER_LOG_FIELDS, jsonSignerLogger, memorySignerLogger } from './log.js';
export type { SignerLogFields, SignerLogLevel, SignerLogRecord, SignerLogger } from './log.js';
export {
  memoryAttestationLog,
  memoryManagedSignerStore,
  memoryMandateIndex,
  memoryRateLimiter,
  memorySponsorshipLedger,
} from './memory.js';
export type {
  MemoryManagedSigner,
  MemoryMandate,
  MemoryPendingAttestation,
  MemoryRateLimit,
  MemoryReservation,
} from './memory.js';
export { backendOnlyPolicy, deny } from './policy.js';
export type { PolicyContext, PolicyDecision, RefKind, ServicePolicy } from './policy.js';
export type {
  AttestationLog,
  IndexedMandate,
  ManagedSigner,
  ManagedSignerStore,
  MandateIndex,
  PendingAttestation,
  PrincipalRateLimiter,
  RecipientMode,
  SponsorshipIntent,
  SponsorshipLedger,
  SponsorshipReservation,
} from './ports.js';
export { memorySigningKeyRegistry, refOfRow, verifyServedKeys } from './registry.js';
export type {
  ServedKeysOptions,
  SigningKeyPurpose,
  SigningKeyRegistry,
  SigningKeyRow,
} from './registry.js';
export { startSignerService } from './serve.js';
export type { RunningService, ServeOptions } from './serve.js';
export { createSignerService } from './service.js';
export type { SignerServiceOptions } from './service.js';
