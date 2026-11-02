// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/chain-adapter/stellar: the Stellar side of the adapter. It is its
// own entry so the root entry stays free of the Stellar SDK; only the
// service that wires up a network loads this one. Nothing exported here
// names an SDK type.

export { checkStellarDestination } from './check-destination.js';
export type {
  StellarCheckDestinationRequest,
  StellarLedgerEntry,
  StellarLedgerKey,
  StellarLedgerReader,
} from './check-destination.js';
export { createStellarLedgerReader } from './ledger-reader.js';
export { StellarMandateAdapter } from './mandate-adapter.js';
export { buildRecipientActivation } from './recipient-activation.js';
export type { StellarRecipientActivationRequest } from './recipient-activation.js';
export { checkStellarWalletProof, verifyStellarWalletProof } from './wallet-proof.js';
export type { StellarMandateAdapterOptions, StellarMandateOperations } from './mandate-adapter.js';
export { mandateAddressOf } from './mandate-address.js';
export { createMemorySigningRequestStore } from './requests.js';
export type {
  LoadedSigningRequest,
  SigningRequestStore,
  SigningRequestUse,
  StoredSigningRequest,
} from './requests.js';
export {
  INSTANCE_TTL_EXTEND_LEDGERS,
  RECORD_TTL_MARGIN_SECONDS,
  extensionPlan,
} from './restore-policy.js';
export type { ExtensionGroup, ExtensionPolicy, RestoredEntry } from './restore-policy.js';
export { createStellarRpc } from './rpc.js';
export { accountBalance } from './tx.js';
export type {
  JsonRpcOptions,
  RpcLatestLedger,
  RpcLedgerEntry,
  RpcSendResult,
  RpcSendStatus,
  RpcTransaction,
  StellarRpc,
} from './rpc.js';
