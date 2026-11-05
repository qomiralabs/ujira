// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/chain-adapter/testing/stellar: the real Stellar adapter over a scripted
// offline RPC, for a package that needs to test against what the adapter really
// produces rather than its own idea of it. Test code only.

export { NETWORK, OPTS } from './test-adapter.js';
export {
  authEntryFor,
  entryHash,
  footprintXdr,
  payRequest,
  payWorld,
  record,
  relayedCallXdr,
  signedBy,
  sourceAccountEntry,
  withWalletSignature,
} from './test-payouts.js';
export type { PayWorld } from './test-payouts.js';
