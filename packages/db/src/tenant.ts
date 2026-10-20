// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The tenant context every query runs under, sent as transaction local
// settings. Two measurements from the Supabase spike shape this file:
//
// - the context statement on its own cost a full network round trip (178 ms
//   p50 from outside the region), so it travels with BEGIN in one statement,
//   which is one round trip;
// - a session level setting was read by another client on the same pooled
//   backend, so every setting here is transaction local and the guard in
//   session-state.ts refuses anything else.
//
// A parameter cannot ride along with BEGIN in a simple query, so the values
// are inlined. They are inlined only after passing a strict check: a value
// that is not exactly a lower case UUID, or one of the two known scopes, is
// refused rather than escaped. Escaping would make a malformed value
// someone else's problem later; refusing it ends there.

import { TenantContextError } from './errors.js';

export type TenantScope = 'project' | 'all';

export interface TenantContext {
  readonly principalId: string;
  readonly projectId: string;
  // `project` sees one project. `all` reads every project of the principal
  // and writes nothing; the spike measured the policies refusing its writes.
  readonly scope: TenantScope;
}

// The settings a transaction carries. `txid` is the spike's recommendation:
// the tenancy migration's `current_principal_id()` refuses when it does not
// match `txid_current()`, so a setting that somehow outlived its transaction
// is refused instead of used.
export const TENANT_SETTINGS = [
  'ujira.principal_id',
  'ujira.project_id',
  'ujira.scope',
  'ujira.txid',
] as const;

const SCOPES: ReadonlySet<string> = new Set<TenantScope>(['project', 'all']);

// Lower case canonical UUID only. Postgres accepts braces, upper case and
// other spellings, so two rows could carry the same identifier written two
// ways; one spelling keeps a tenant comparison exact.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new TenantContextError(
      `refused: ${field} must be a lower case canonical UUID, 36 characters with four hyphens`,
    );
  }
}

function assertScope(value: string): void {
  if (!SCOPES.has(value)) {
    throw new TenantContextError(`refused: scope must be one of ${[...SCOPES].sort().join(', ')}`);
  }
}

// `begin` and the context in one statement. Every value in it has passed the
// checks above, so nothing here is escaped: there is nothing left to escape.
export function beginWithTenant(context: TenantContext): string {
  assertUuid(context.principalId, 'principalId');
  assertUuid(context.projectId, 'projectId');
  assertScope(context.scope);
  return [
    'begin;',
    'select',
    `set_config('ujira.principal_id', '${context.principalId}', true),`,
    `set_config('ujira.project_id', '${context.projectId}', true),`,
    `set_config('ujira.scope', '${context.scope}', true),`,
    `set_config('ujira.txid', txid_current()::text, true)`,
  ].join(' ');
}
