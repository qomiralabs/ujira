// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The shared identity contract against the in-memory stand-ins. The database
// package runs the same cases against Postgres.

import { describe, expect, it } from 'vitest';

import { IDENTITY_CONTRACT_CASES } from './contract.js';
import { memoryContractBackend } from './memory-contract.js';

describe('the identity contract, in memory', () => {
  it.each(IDENTITY_CONTRACT_CASES.map((entry) => [entry.name, entry] as const))(
    '%s',
    async (_name, entry) => {
      expect(await entry.run(memoryContractBackend())).toEqual(entry.expected);
    },
  );
});
