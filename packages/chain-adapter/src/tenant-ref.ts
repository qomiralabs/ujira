// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The tenant reference a mandate stores: SHA-256 over a domain tag and the
// principal and project UUIDs as raw bytes. The mandate never interprets it;
// the adapter recomputes it from the request scope and compares, so a request
// for one tenant can never act on another tenant's mandate.

import { createHash } from 'node:crypto';

import { InvalidInputError } from './errors.js';
import type { Bytes32, TenantScope } from './types.js';

const TENANT_TAG = 'ujira/tenant/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidBytes(field: string, value: unknown): Buffer {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InvalidInputError({ issues: [`${field} (invalid)`] });
  }
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

/** The 32 byte tenant reference for a scope, as 0x and 64 lowercase hex characters. */
export function tenantRefOf(scope: TenantScope): Bytes32 {
  const digest = createHash('sha256')
    .update(TENANT_TAG, 'ascii')
    .update(uuidBytes('scope.principalId', scope.principalId))
    .update(uuidBytes('scope.projectId', scope.projectId))
    .digest('hex');
  return `0x${digest}` as Bytes32;
}
