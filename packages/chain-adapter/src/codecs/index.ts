// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/chain-adapter/codecs: pure Stellar encodings, with no network
// access and no state. It is the one chain specific import the signer is
// allowed, so whatever the signer can reach from here it can reach at all.
// The lint config holds this folder to node:crypto, core, the Stellar base
// library and the adapter's pure modules, with no dynamic import and no
// network global. Decoders return plain data, never the XDR library's own
// objects, so nothing that imports them depends on that library's types.

export { ATTESTATION_MESSAGE_BYTES, attestationMessage } from './attestation.js';
export type { AttestationMessageFields } from './attestation.js';
export { attachAuthEntrySignature, decodeAuthEntry } from './auth-entry.js';
export type { DecodedAuthCredentials, DecodedAuthEntry, DecodedInvocation } from './auth-entry.js';
export {
  MAX_ENVELOPE_SIGNATURES,
  attachEnvelopeSignature,
  decodeFeeBumpEnvelope,
  decodeTransactionEnvelope,
  invocationAuthEntries,
} from './envelope.js';
export type {
  DecodedFeeBump,
  DecodedOperation,
  DecodedSignature,
  DecodedTimeBounds,
  DecodedTransaction,
} from './envelope.js';
export { networkIdOf, networkPassphrase } from './network.js';
export type { DecodedOperationDetail, DecodedTrustAsset } from './operations.js';
export { CONTRACT_OPERATION_TYPES, assertNoMemoOnContractCall } from './memo.js';
export {
  ZERO_ACCOUNT_ADDRESS,
  ZERO_CONTRACT_ADDRESS,
  baseAddress,
  decodeAccountAddress,
  encodeAccountAddress,
  encodeMuxedAddress,
  isAccountAddress,
  isContractAddress,
  isZeroAddress,
} from './strkey.js';
export type { DecodedAccount, Ed25519SignatureParts } from './xdr.js';
