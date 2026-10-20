// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { TenantContextError } from './errors.js';
import { holdsSessionState, setConfigArguments } from './session-state.js';
import { beginWithTenant, TENANT_SETTINGS, type TenantContext } from './tenant.js';

const PRINCIPAL = '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12';
const PROJECT = '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04';

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return { principalId: PRINCIPAL, projectId: PROJECT, scope: 'project', ...overrides };
}

describe('beginWithTenant', () => {
  it('sends begin and the context in one statement, so one round trip', () => {
    const sql = beginWithTenant(context());
    // One string means one query call, which is one round trip. The spike
    // measured the separate context statement costing a whole round trip.
    expect(sql.startsWith('begin;')).toBe(true);
    expect(sql.split('begin').length - 1).toBe(1);
    expect(sql.includes('\u0000')).toBe(false);
  });

  it('sets every tenant setting, transaction local, plus the transaction id', () => {
    const sql = beginWithTenant(context());
    for (const key of TENANT_SETTINGS) {
      expect(sql).toContain(`set_config('${key}'`);
    }
    expect(sql).toContain('txid_current()::text');
    // Read with the same splitter the guard uses, so a nested call such as
    // txid_current() does not fool the check.
    const calls = setConfigArguments(sql);
    expect(calls).toHaveLength(TENANT_SETTINGS.length);
    for (const args of calls) {
      expect(args).toHaveLength(3);
      expect(args[2]).toBe('true');
    }
  });

  it('passes its own guard, so the helper cannot set session state', () => {
    expect(holdsSessionState(beginWithTenant(context()))).toBe(false);
  });

  it('inlines the values, because a parameter cannot ride with begin', () => {
    const sql = beginWithTenant(context());
    expect(sql).toContain(PRINCIPAL);
    expect(sql).toContain(PROJECT);
    expect(sql).not.toContain('$1');
  });

  it.each(['project', 'all'] as const)('accepts the scope %s', (scope) => {
    expect(beginWithTenant(context({ scope }))).toContain(`set_config('ujira.scope', '${scope}'`);
  });

  it.each([
    ['an empty principal', { principalId: '' }],
    ['an empty project', { projectId: '' }],
    ['a principal that is not a uuid', { principalId: 'not-a-uuid' }],
    ['a project that is not a uuid', { projectId: '0199a1f6-4c7d-7a55-8e21' }],
    ['a uuid with a trailing space', { principalId: `${PRINCIPAL} ` }],
    ['a uuid in upper case', { principalId: PRINCIPAL.toUpperCase() }],
    ['a braced uuid', { principalId: `{${PRINCIPAL}}` }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => beginWithTenant(context(overrides as Partial<TenantContext>))).toThrow(
      TenantContextError,
    );
  });

  it('refuses a scope outside the two it knows', () => {
    expect(() => beginWithTenant(context({ scope: 'admin' as 'project' }))).toThrow(
      TenantContextError,
    );
  });

  it.each(["'; drop table payout; --", "' or true --", 'injected-value-with-quote'])(
    'refuses the injection attempt %s rather than escaping it',
    (value) => {
      expect(() => beginWithTenant(context({ principalId: value }))).toThrow(TenantContextError);
    },
  );

  it('never names the value it refused', () => {
    let message = '';
    try {
      beginWithTenant(context({ principalId: "'; drop table payout; --" }));
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('principalId');
    expect(message).not.toContain('drop table');
  });

  it('is the same statement every time, so it can be compared and cached', () => {
    expect(beginWithTenant(context())).toBe(beginWithTenant(context()));
  });
});
