// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The receipt model, its canonical document and hash, the principal and
// recipient views, and receipt signing through a port.
//
// Storage is deliberately not here, only a port for it. Receipts and their
// legs are append-only tables owned by the db package's repository layer;
// keeping this package free of I/O means the same code builds, hashes and verifies a receipt in
// the API, in a worker and in a verifier, and the store can move without
// touching it.

/** Package name, exported so consumers and tests can confirm the build wiring. */
export const PACKAGE_NAME = '@ujira/receipts';

export { canonicalJson, sha256Hex } from './canonical.js';
export type { CanonicalValue } from './canonical.js';
export {
  RECEIPT_DOCUMENT_FORMAT,
  canonicalReceipt,
  documentSha256,
  parseReceiptDocument,
  receiptDocument,
} from './document.js';
export type { AmountDocument, ReceiptDocument, ReceiptLegDocument } from './document.js';
export {
  ReceiptChainAbortedError,
  ReceiptChainTimeoutError,
  ReceiptError,
  ReceiptInvalidError,
  ReceiptNotCanonicalError,
  ReceiptNotIssuedError,
  ReceiptNotPaidError,
  ReceiptOptionsInvalidError,
  ReceiptPresentationInvalidError,
  ReceiptSignatureInvalidError,
  ReceiptSigningAbortedError,
  ReceiptSigningTimeoutError,
  ReceiptTenantMismatchError,
  ReceiptUnverifiedError,
} from './errors.js';
export type { ReceiptErrorCode } from './errors.js';
export {
  RECEIPT_ISSUE_MAX_ATTEMPTS,
  RECEIPT_ISSUE_TASK,
  issueReceipt,
  issueReceiptCorrection,
  receiptIssueJobKey,
  receiptIssueTask,
  receiptNumberFor,
} from './issue.js';
export type {
  PaidLeg,
  PaidPayout,
  ReceiptAlerts,
  ReceiptBlockReason,
  ReceiptCorrectionRequest,
  ReceiptIssueOutcome,
  ReceiptIssuePorts,
  ReceiptIssueStore,
  StoredReceipt,
} from './issue.js';
export {
  LOCAL_PAYOUT_METHODS,
  MAX_FEE_BPS,
  MAX_RECEIPT_LEGS,
  WALLET_PAYOUT_METHODS,
  buildReceipt,
  feeCap,
  isWalletLeg,
  isWalletMethod,
} from './model.js';
export type {
  FeeRefund,
  LocalPayoutMethod,
  LocalReceiptLeg,
  PayoutMethod,
  Receipt,
  ReceiptDestination,
  ReceiptFee,
  ReceiptInput,
  ReceiptLeg,
  ReceiptLegInput,
  ReceiptRevisionRef,
  WalletPayoutMethod,
  WalletReceiptLeg,
} from './model.js';
export {
  MAX_SIGNING_TIMEOUT_MS,
  RECEIPT_SIGNING_DOMAIN,
  receiptSigningMessage,
  signReceipt,
  verifyReceiptSignature,
} from './signing.js';
export type {
  ReceiptSignature,
  ReceiptSigner,
  ReceiptSigningFields,
  SignReceiptOptions,
} from './signing.js';
export { principalView, recipientView } from './views.js';
export type {
  NetworkPresentation,
  PrincipalLegView,
  PrincipalReceiptView,
  RecipientLegView,
  RecipientLocalLegView,
  RecipientReceiptView,
  RecipientWalletLegView,
  ViewOptions,
} from './views.js';
