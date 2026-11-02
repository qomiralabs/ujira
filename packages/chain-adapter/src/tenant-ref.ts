// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Two values tie a mandate to its tenant. The tenant reference is the
// operator's ID for a principal and project: SHA-256 over a domain tag and
// the two UUIDs as raw bytes. It stays off chain. What a mandate stores and
// publishes is the tenant tag, the reference hashed with that mandate's own
// address, so two mandates of one tenant carry unrelated values and the
// ledger cannot group them. Only a holder of the reference can recompute a
// tag, which is how a request for one tenant is kept from acting on another
// tenant's mandate.

import { createHash } from 'node:crypto';

import { InvalidInputError } from './errors.js';
import type { Bytes32, TenantScope } from './types.js';

const TENANT_REF_DOMAIN = 'ujira/tenant/v1';
const TENANT_TAG_DOMAIN = 'ujira/tenant-tag/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BYTES32 = /^0x[0-9a-f]{64}$/;

function uuidBytes(field: string, value: unknown): Buffer {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InvalidInputError({ issues: [`${field} (invalid)`] });
  }
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

/** The tenant reference for a scope, as 0x and 64 lowercase hex characters. Off chain only. */
export function tenantRefOf(scope: TenantScope): Bytes32 {
  const digest = createHash('sha256')
    .update(TENANT_REF_DOMAIN, 'ascii')
    .update(uuidBytes('scope.principalId', scope.principalId))
    .update(uuidBytes('scope.projectId', scope.projectId))
    .digest('hex');
  return `0x${digest}` as Bytes32;
}

/**
 * The tag a mandate stores for a tenant. `mandateXdr` is the mandate's own
 * address in the bytes the chain hashes it as, so the tag can be computed
 * before the mandate exists, from the address it will be deployed at.
 */
export function tenantTagOf(tenantRef: Bytes32, mandateXdr: Uint8Array): Bytes32 {
  if (typeof tenantRef !== 'string' || !BYTES32.test(tenantRef)) {
    throw new InvalidInputError({ issues: ['tenantRef (invalid)'] });
  }
  const digest = createHash('sha256')
    .update(TENANT_TAG_DOMAIN, 'ascii')
    .update(Buffer.from(tenantRef.slice(2), 'hex'))
    .update(mandateXdr)
    .digest('hex');
  return `0x${digest}` as Bytes32;
}
