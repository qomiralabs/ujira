// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

export { networksConfigSchema, parseNetworksConfig } from './config.js';
export { CHAIN_NAMESPACES, CHAIN_SDK_PACKAGES } from './chain-modules.js';
export type { ChainNamespace } from './chain-modules.js';
export type { KeyRef, NetworksConfig, StellarNetworkConfig } from './config.js';
export {
  ADAPTER_LOG_SERIALIZERS,
  CHAIN_ADAPTER_ERROR_CODES,
  CHAIN_ADAPTER_ERROR_MESSAGES,
  ActivationBudgetExhaustedError,
  DESTINATION_PARSE_REASONS,
  ChainAdapterError,
  ChainUnavailableError,
  CrossChainLiveError,
  DestinationInvalidError,
  UNSUPPORTED_MEMO_DESTINATION_MESSAGE,
  UnsupportedMemoDestinationError,
  ExecutorUnfundedError,
  InternalError,
  InvalidInputError,
  LiquidityUnavailableError,
  MandateRuleError,
  MandateUntrustedError,
  MemoOnContractCallError,
  QuoteExpiredError,
  QuoteUnavailableError,
  RailActionRequiredError,
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
  ReorgedError,
  RpcLaggingError,
  RpcRateLimitedError,
  RpcTimeoutError,
  SignedPayloadMismatchError,
  SignerAddressMismatchError,
  SignerDeniedError,
  SignerUnavailableError,
  SigningRequestExpiredError,
  SponsorDeniedError,
  SponsorUnfundedError,
  SubmissionRejectedError,
  SubmissionUnknownError,
  TenantMismatchError,
  UnsupportedError,
  isChainAdapterError,
  mandateRuleErrorOf,
  serializeAdapterError,
} from './errors.js';
export type {
  AdapterErrorLog,
  ChainAdapterErrorCode,
  ChainAdapterErrorJson,
  ChainAdapterErrorOptions,
  DestinationParseReason,
  InvalidInputErrorOptions,
  Landed,
  WaitFor,
} from './errors.js';
export {
  DESTINATION_MEMO_TYPES,
  readBindableDestination,
  readProviderDepositInstruction,
} from './destination.js';
export type { BindableDestination, DestinationInput, DestinationMemoType } from './destination.js';
export { operationsGuardianOf } from './guardian.js';
export {
  SIGNER_DOWN,
  SPONSOR_LOW,
  SPONSOR_UNFUNDED,
  withSignerHealth,
  withSponsorHealth,
} from './health.js';
export {
  createSponsorshipPolicy,
  createUncoveredBudget,
  monthOf,
  reservationIdOf,
  sponsorshipReservations,
} from './sponsorship/policy.js';
export type {
  ManagedSponsorshipPolicy,
  SponsorFunding,
  SponsorshipPolicyOptions,
} from './sponsorship/policy.js';
export type {
  ActivationKey,
  ReservationState,
  SponsorshipLedger,
  SponsorshipQuery,
  SponsorshipRow,
  SponsorshipTotals,
} from './sponsorship/ledger.js';
export {
  MANDATE_ERRORS,
  MANDATE_ERROR_NAMES,
  MANDATE_ERROR_NAMES_BY_CODE,
  isMandateErrorName,
  mandateErrorName,
} from './mandate-errors.js';
export type { MandateErrorName } from './mandate-errors.js';
export { PUBLIC_TEST_ATTESTER_KEYS, isPublicTestAttesterKey } from './test-attester-keys.js';
export { pinnedKeys, verifyPinnedAddresses } from './key-ref.js';
export type { PinnedKey } from './key-ref.js';
export { NETWORK_IDS, chainOf, isNetworkId } from './networks.js';
export type { NetworkId, StellarNetworkId } from './networks.js';
export { RAIL_IDS, isRailId } from './rails.js';
export { RECEIPT_HASH_FORMATS, formatReceiptRef, parseReceiptRef } from './receipt-ref.js';
export type { ReceiptRefParts } from './receipt-ref.js';
export { createChainAdapterRegistry } from './registry.js';
export type { ChainAdapterRegistryOptions } from './registry.js';
export {
  SIGNER_ERROR_CODES,
  SIGNER_RETRY_RULES,
  isSignerErrorCode,
  signerRetryDecision,
} from './retry.js';
export type { AlertKind, RetryDecision, RetryRule, SignerErrorCode } from './retry.js';
export type * from './signer.js';
export { createRentWatch, utcDay } from './stellar/rent-watch.js';
export type {
  RentAlertKind,
  RentAlerts,
  RentMetrics,
  RentSpendStore,
  RentWatch,
  RentWatchOptions,
} from './stellar/rent-watch.js';
export { bisectRounds, planBatch } from './bisect.js';
export type {
  BatchAlert,
  BatchPlan,
  BatchPlanOptions,
  BatchSimulation,
  BatchSimulationPort,
} from './bisect.js';
export { parseTtlConfig, TTL_KEEP_ALIVE_TASK, ttlKeepAliveTask } from './stellar/ttl-job.js';
export type {
  KeepAliveTargets,
  TtlConfig,
  TtlKeepAlivePayload,
  TtlPorts,
} from './stellar/ttl-job.js';
export { tenantRefOf, tenantTagOf } from './tenant-ref.js';
export { CHAIN_ADAPTER_INTERFACE_VERSION } from './types.js';
export type * from './types.js';
