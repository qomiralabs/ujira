// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/chain-adapter/codecs: pure Stellar encodings, with no network
// access and no state. It is the one chain specific import the signer is
// allowed, so whatever the signer can reach from here it can reach at all.
// The lint config holds this folder to node:crypto, core, the Stellar base
// library and the adapter's pure modules, with no dynamic import and no
// network global. Envelope, fee bump and authorization entry decoders join
// it together with the Stellar XDR library.

export { CONTRACT_OPERATION_TYPES, assertNoMemoOnContractCall } from './memo.js';
export {
  decodeAccountAddress,
  encodeAccountAddress,
  isAccountAddress,
  isContractAddress,
} from './strkey.js';
