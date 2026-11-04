// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createMemoryRoutingConfigStore } from './index.js';
import { describeRoutingConfigStore } from './testing/index.js';

describeRoutingConfigStore('the in-memory store', () =>
  Promise.resolve(createMemoryRoutingConfigStore()),
);
