// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The public entry of the database package. Everything that reaches a
// database goes through here: the driver and the query builder are imports
// of this package alone, enforced by a lint fence, so no caller can open a
// connection without a tenant context.
//
// What is deliberately not exported: the pg pool, the kysely instance and
// the generated schema types. A caller that needs a query needs a
// repository method, which arrives with the tables.

export {
  createDatabase,
  type Database,
  type DatabaseHooks,
  type DatabaseRole,
  type ProjectContext,
  type TenantSession,
} from './database.js';
export {
  MAX_PAGE_SIZE,
  PageRequestError,
  type Page,
  type PageRequest,
} from './repositories/page.js';
export {
  apiTokens,
  members,
  principals,
  projects,
  type ApiToken,
  type Member,
  type MemberRole,
  type NewApiToken,
  type ChainFallback,
  type Principal,
  type Project,
  type ProjectSettings,
} from './repositories/tenancy.js';
export {
  AmountBelowMinimumError,
  MinimumNotComparableError,
  PAYOUT_MINIMUM_METHODS,
  requiredMinimum,
  type MinimumAmount,
  type MinimumReason,
  type PayoutMinimumContext,
  type PayoutMinimumMethod,
  type RequiredMinimum,
  type ToUsd,
} from './payout-minimum.js';
export {
  ATTEMPT_STATUS_VALUES,
  fundingHolds,
  IdempotencyConflictError,
  IllegalTransitionError,
  AttemptWithoutLegsError,
  LiveAttemptError,
  PAYOUT_STATUS_VALUES,
  payoutAttempts,
  payoutBatches,
  payoutMinimums,
  payouts,
  RequestedAmountModeError,
  type AttemptStatusValue,
  type BatchItemResult,
  type CashoutCostBearer,
  type CreatedBatch,
  type CreatedPayout,
  type FundingHold,
  type FundingHoldInput,
  type NewPayout,
  type NetworkId,
  type NewPayoutAttempt,
  type Payout,
  type PayoutAttempt,
  type PayoutBatch,
  type PayoutStatusReason,
  type PayoutStatusValue,
  type NewPayoutLeg,
  type ProjectPayoutMinimum,
} from './repositories/payouts.js';
export {
  approvals,
  LEG_STATUS_VALUES,
  payoutLegs,
  type Approval,
  type ApprovalDecision,
  type LegStatusValue,
  type NewApproval,
  type PayoutLeg,
  type RecordedApproval,
} from './repositories/payout-legs.js';
export {
  managedSigners,
  signingKeys,
  type ManagedSigner,
  type NewManagedSigner,
  type SignerKeyStatus,
  type SigningKey,
  type SigningKeyPurpose,
} from './repositories/signers.js';
export {
  entryPoints,
  type CreatedPrincipal,
  type NewPrincipal,
  type ResolvedInstance,
  type TokenRecord,
} from './repositories/entry-points.js';
export {
  audit,
  AuditScopeError,
  type AuditActor,
  type AuditChainBreak,
  type AuditEntry,
  type AuditMetadata,
  type AuditVerification,
  type NewAuditEntry,
} from './repositories/audit.js';
export {
  ledger,
  type LedgerAccount,
  type LedgerAccountKind,
  type LedgerEntry,
  type LedgerEntryInput,
  type MandateState,
  type PostResult,
  type Reconciliation,
} from './repositories/ledger.js';
export {
  payoutMethods,
  recipientIdentities,
  recipientPii,
  recipients,
  type EncryptedValue,
  type IdentityAssurance,
  type IdentityChange,
  type IdentityState,
  type IdentityUpdate,
  type NewProviderIdentity,
  type NewPayoutMethod,
  type PayoutMethod,
  type PayoutMethodKind,
  type Recipient,
  type RecipientIdentity,
  type RecipientStatus,
} from './repositories/recipients.js';
export {
  HeldPayoutUnreadableError,
  UnsupportedSpecVersionError,
  createRouteStores,
  type RouteStoreOptions,
  type RouteStores,
} from './route-stores.js';
export {
  routing,
  type HeldRow,
  type InstanceOfMandate,
  type UsableMethod,
} from './repositories/routing.js';
export {
  executors,
  identityProviderEvents,
  routingConfig,
  type IdentityProviderEvent,
  type ExecutorLease,
  type RoutingConfig,
} from './repositories/ops.js';
export {
  FEE_ESTIMATE_OPS,
  feeEstimates,
  type FeeEstimate,
  type FeeEstimateOp,
} from './repositories/fee-estimates.js';
export {
  chainEvents,
  deposits,
  fundingSources,
  fundingSweeps,
  instanceRoles,
  mandateInstances,
  mandates,
  type ChainEvent,
  type Deposit,
  type FundingAccountConfig,
  type FundingSource,
  type FundingSweep,
  type FundingSweepMove,
  type FundingSweepStatus,
  type NewFundingSource,
  type NewFundingSweep,
  type InstanceRole,
  type Mandate,
  type MandateInstance,
  type MandateRole,
  type NewChainEvent,
  type NewDeposit,
  type NewMandateInstance,
  type RoleGrant,
} from './repositories/mandates.js';
export {
  CONNECTION_BUDGET,
  loadDatabaseConfig,
  POOL_DEFAULTS,
  type DatabaseConfig,
  type DatabaseEnvironment,
  type RoleConnection,
  type TlsMode,
} from './config.js';
// Exported so a deployment can check which certificate it is pinning
// without importing the driver.
export { PINNED_TLS, SUPABASE_ROOT_2021_CA_FINGERPRINT } from './tls.js';
export {
  runMigrations,
  type LockMode,
  type MigrationDirection,
  type MigrationRun,
} from './migrate.js';
export { TENANT_SETTINGS, type TenantContext, type TenantScope } from './tenant.js';
export { DatabaseConfigError, SessionStateError, TenantContextError } from './errors.js';
export { DatabaseUnavailableError } from './unavailable.js';
