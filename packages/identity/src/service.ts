// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { TenantScope, Uuid } from '@ujira/chain-adapter';
import { z } from 'zod';

import { parseProjectIdentitySettings } from './config.js';
import { decideEligibility } from './eligibility.js';
import { IdentityInputError, IdentityTenantMismatchError, issuesOf } from './errors.js';
import type { IdentityServicePorts } from './ports.js';
import type {
  EligibilityRequest,
  EligibilityResult,
  IdentityContext,
  IdentityService,
} from './types.js';

const uuid = z.uuid();

const scopeSchema = z.strictObject({ principalId: uuid, projectId: uuid });

const contextSchema = z.object({
  scope: scopeSchema,
  correlationId: z.string().min(1).max(128),
});

const eligibilityRequestSchema = z.strictObject({
  recipientId: uuid,
  methodId: uuid,
  mandateInstanceId: uuid,
});

/** Validates the tenant and the trace ID every call carries. */
export function checkedScope(ctx: IdentityContext): TenantScope {
  const parsed = contextSchema.safeParse(ctx);
  if (!parsed.success) throw new IdentityInputError(issuesOf(parsed.error));
  ctx.signal?.throwIfAborted();
  return {
    principalId: parsed.data.scope.principalId as Uuid,
    projectId: parsed.data.scope.projectId as Uuid,
  };
}

/** Throws unless every row is the caller's own. */
export function assertScope(
  scope: TenantScope,
  rows: readonly ({ readonly scope: TenantScope } | null)[],
): void {
  for (const row of rows) {
    if (
      row !== null &&
      (row.scope.principalId !== scope.principalId || row.scope.projectId !== scope.projectId)
    ) {
      throw new IdentityTenantMismatchError();
    }
  }
}

function checkedRequest(req: EligibilityRequest): EligibilityRequest {
  const parsed = eligibilityRequestSchema.safeParse(req);
  if (!parsed.success) throw new IdentityInputError(issuesOf(parsed.error));
  return {
    recipientId: parsed.data.recipientId as Uuid,
    methodId: parsed.data.methodId as Uuid,
    mandateInstanceId: parsed.data.mandateInstanceId as Uuid,
  };
}

export function createIdentityService(ports: IdentityServicePorts): IdentityService {
  return {
    async eligibility(ctx, rawRequest): Promise<EligibilityResult> {
      const scope = checkedScope(ctx);
      const req = checkedRequest(rawRequest);
      const { store } = ports;
      const [instance, recipient, method, identities, rawSettings] = await Promise.all([
        store.mandateInstance(scope, req.mandateInstanceId),
        store.recipient(scope, req.recipientId),
        store.payoutMethod(scope, req.methodId),
        store.identities(scope, req.recipientId),
        store.projectSettings(scope),
      ]);
      assertScope(scope, [instance, recipient, method, ...identities]);
      return decideEligibility({
        instance,
        recipient,
        method,
        rail: method === null ? null : ports.rails.rail(method.network, method.rail),
        settings: parseProjectIdentitySettings(rawSettings),
        identities,
        config: ports.config(),
        now: ports.clock.nowSeconds(),
      });
    },
  };
}
