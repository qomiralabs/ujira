// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// UJIRA's own mandate rules, applied off chain around what the contract
// enforces: what a new mandate must contain, which mandates may be created
// and which may be served.

export {
  BLOCKED_BY_POLICY,
  RETIRED_REASONS,
  WATCHED_MANDATE_EVENTS,
  createMemoryComplianceStore,
  guardSubmission,
  onMandateEvent,
  onMandateRetired,
  recheckPrincipal,
  servableInstances,
} from './compliance.js';
export type {
  ComplianceDeps,
  ComplianceNotice,
  ComplianceStore,
  InstanceKey,
  MemoryComplianceStore,
  NoncompliantMark,
  RetiredOutcome,
  RetiredReason,
  SubmissionDecision,
} from './compliance.js';
export { instanceIdOf, planMandateCreation } from './create-mandate.js';
export type { CreateMandateRequest, CreationDeps, MandateCreationPlan } from './create-mandate.js';
export {
  allowsManagedAgent,
  assertCustodyAllowed,
  assertMayAddManagedAgent,
  createMemoryManagedAgentKeys,
  createMemoryManagedAgentMandates,
  recipientModesOffered,
  withCustodyGuard,
} from './custody.js';
export type {
  CustodyGuardDeps,
  ManagedAgentKeys,
  ManagedAgentMandates,
  RecipientMode,
} from './custody.js';
export {
  CustodyGuardError,
  MANDATE_POLICY_ERROR_CODES,
  MandatePolicyError,
  OperationsGuardianNotConfiguredError,
  PRINCIPAL_KEY_FIXES,
  PrincipalKeyRiskError,
  PolicyStoreError,
  PolicyStoreTimeoutError,
  isMandatePolicyError,
} from './errors.js';
export type { MandatePolicyErrorCode, PrincipalKeyFix } from './errors.js';
export {
  createMemoryGuardianOptOutStore,
  knownGuardians,
  onRoleRemoved,
  reconcileOperationsGuardian,
} from './operations-guardian.js';
export type {
  GuardianOptOutStore,
  GuardianPolicyDeps,
  OnChainGuardians,
  OperationsGuardianStatus,
  RoleRemoved,
} from './operations-guardian.js';
export { PORT_TIMEOUT_MS, callPort, keyText } from './ports.js';
export type { LogicalMandateKey, PortCallOptions } from './ports.js';
export {
  PRINCIPAL_KEY_LIMIT,
  assertMayChangeBudget,
  assertMayCreate,
  cachePrincipalKeyReader,
  checkPrincipalKeyRule,
  createMemoryPrincipalInstances,
  createMemoryPrincipalKeyReader,
  evaluateInstances,
  isAboveLimit,
  logicalBudgetUsd,
  principalKeyWarning,
} from './principal-key.js';
export type {
  InstanceView,
  PrincipalInstances,
  PrincipalKeyDeps,
  PrincipalKeyReader,
  PrincipalKeyVerdict,
  PrincipalKeyWarning,
  PrincipalReadOptions,
  PrincipalSigning,
} from './principal-key.js';
export { CUSTODY_VECTORS } from './custody-vectors.js';
export type { CustodyVector } from './custody-vectors.js';
