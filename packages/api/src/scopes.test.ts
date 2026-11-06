// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from the route registry, so a new route is held to this the moment
// it is listed, without anyone remembering to add a case for it.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import { API_SCOPES, refuseAllCredentials } from './auth.js';
import { RouteRegistryError } from './errors.js';
import { memoryIdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { withOpenApiRoute } from './openapi.js';
import { allowEveryAddress, allowEveryRequest } from './rate-limit.js';
import { defineTenantRoute, requiresIdempotencyKey, routeAccessProblems } from './route.js';
import type { Route } from './route.js';
import { V1_ROUTES } from './routes/index.js';

const ALL_ROUTES = withOpenApiRoute(V1_ROUTES).routes;

const thing = defineTenantRoute({
  id: 'getThing',
  method: 'GET',
  path: '/v1/things',
  summary: 'A thing',
  scope: 'payouts:read',
  response: { name: 'Thing', schema: z.strictObject({ id: z.string() }) },
  handler: () => Promise.resolve({ id: 'x' }),
});

describe('every route in the registry', () => {
  it('is listed, so the cases below are not vacuous', () => {
    expect(ALL_ROUTES.length).toBeGreaterThan(0);
    expect(ALL_ROUTES.some((route) => route.access.kind === 'tenant')).toBe(true);
  });

  it.each(ALL_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))(
    '%s declares a scope from the list, the roles that may act, or why it needs no key',
    (_name, route) => {
      expect(routeAccessProblems([route])).toEqual([]);
      if (route.access.kind === 'tenant') {
        expect(API_SCOPES).toContain(route.access.scope);
      } else if (route.access.kind === 'member') {
        expect(route.access.roles.length).toBeGreaterThan(0);
        // Every member route so far changes something a person must confirm.
        expect(route.access.stepUp).toBe(true);
      } else if (route.access.kind === 'public') {
        expect(route.access.reason.trim().length).toBeGreaterThanOrEqual(10);
      }
    },
  );
});

describe('the check', () => {
  it('finds a member route that allows no role', () => {
    const noRole = {
      ...thing,
      access: { kind: 'member', roles: [], stepUp: true },
    } as unknown as Route;
    expect(routeAccessProblems([noRole])).toEqual([`route ${noRole.id} allows no role`]);
  });

  it('refuses a payout write that skips its Idempotency-Key', () => {
    const skipping = {
      ...thing,
      method: 'POST',
      access: { kind: 'tenant', scope: 'payouts:write', noReplay: true },
    } as unknown as Route;
    expect(routeAccessProblems([skipping])).toEqual([
      `route ${skipping.id} can move money, so it cannot skip its Idempotency-Key`,
    ]);
  });

  it('lets only the writes that answer with a credential skip their key', () => {
    const skipping = V1_ROUTES.filter(
      (route) => route.access.kind === 'tenant' && route.access.noReplay === true,
    )
      .map((route) => route.id)
      .sort();
    expect(skipping).toEqual(['createEmbedInvite', 'createEmbedSession']);
    for (const route of V1_ROUTES.filter((one) => skipping.includes(one.id))) {
      expect(requiresIdempotencyKey(route), route.id).toBe(false);
    }
  });

  const noScope = { ...thing, access: { kind: 'tenant' } } as unknown as Route;
  const madeUpScope = {
    ...thing,
    access: { kind: 'tenant', scope: 'payouts:admin' },
  } as unknown as Route;
  const noReason = { ...thing, access: { kind: 'public', reason: ' ' } } as unknown as Route;
  const noAccess = { ...thing, access: undefined } as unknown as Route;

  it('fails when a route has no scope', () => {
    expect(routeAccessProblems([noScope])).toEqual([
      'route getThing has no scope from the closed list',
    ]);
  });

  it('fails on a scope outside the list', () => {
    expect(routeAccessProblems([madeUpScope])).toEqual([
      'route getThing has no scope from the closed list',
    ]);
  });

  it('fails on a public route with no reason, and on a route that declares neither', () => {
    expect(routeAccessProblems([noReason])).toEqual([
      'route getThing must say why it needs no key',
    ]);
    expect(routeAccessProblems([noAccess])).toEqual(['route getThing declares no access']);
  });

  it.each([
    ['no scope', noScope],
    ['a made up scope', madeUpScope],
    ['no reason', noReason],
    ['no access', noAccess],
  ])('stops the server starting with a route that has %s', (_name, route) => {
    expect(() =>
      createApp({
        routes: [route],
        authenticate: refuseAllCredentials,
        rateLimit: allowEveryRequest,
        idempotency: memoryIdempotencyStore(),
        addressRateLimit: allowEveryAddress,
        logger: memoryLogger(),
      }),
    ).toThrow(RouteRegistryError);
  });
});
