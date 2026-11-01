// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The last check before a tenant response leaves. Every tenant resource in
// the contract names its principal and project, so a row of another tenant
// that slipped past a query is visible in the body itself. Finding one turns
// the response into a 500: refusing to answer is better than answering with
// someone else's data.

import type { Tenant } from './auth.js';

// Bodies are bounded by their schemas; these limits only stop a pathological
// value from making the check itself expensive.
const MAX_DEPTH = 32;
const MAX_NODES = 1_000_000;

const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/** The path of the first principalId or projectId that is not the tenant's, or null. */
export function foreignTenantPath(body: unknown, tenant: Tenant): string | null {
  let nodes = 0;
  const walk = (node: unknown, path: string, depth: number): string | null => {
    nodes += 1;
    if (depth > MAX_DEPTH || nodes > MAX_NODES) return path;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const found = walk(node[i], join(path, String(i)), depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    if (typeof node !== 'object' || node === null) return null;
    for (const [key, value] of Object.entries(node)) {
      const here = join(path, key);
      if (key === 'principalId' && value !== tenant.principalId) return here;
      if (key === 'projectId' && value !== tenant.projectId) return here;
      const found = walk(value, here, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(body, '', 0);
}
