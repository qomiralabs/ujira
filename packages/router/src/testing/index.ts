// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/router/testing: the contract every routing configuration store meets,
// and a valid document to run it with. Test code only.

export {
  MAX_MARKED_VERSION,
  TESTNET,
  markedDocument,
  networkSection,
  routingDocument,
} from './documents.js';
export type { TestDocument } from './documents.js';
export { describeRoutingConfigStore } from './store-contract.js';
