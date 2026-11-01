// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/identity/testing: in-memory stand-ins for the identity tables and
// row builders. Test code only; nothing here reaches a database or a provider.

export {
  ANCHOR_RAIL,
  ManualClock,
  StaticRailCatalog,
  TEST_NETWORK,
  TEST_NOW,
  WALLET_RAIL,
  accountOf,
  bytes32Of,
  contractOf,
  country,
  identityRow,
  mandateRow,
  methodRow,
  newId,
  newScope,
  railCapability,
  recipientRow,
  seedOf,
} from './fixtures.js';
export { InMemoryIdentityStore, tenantKey } from './memory-store.js';
