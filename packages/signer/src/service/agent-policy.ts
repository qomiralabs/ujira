// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The agent signer's policy, for the agent keys UJIRA holds for principals
// who opted in. Such a key may only ever ask for a payout: one call to
// request_payout or its batch, on a mandate of the request's own tenant,
// with the active key of that tenant and agent, under a per principal rate
// limit. A mandate that only pays attested recipients is refused, because
// an agent request there could never pass the recipient check. Approving,
// revoking or changing anything stays with the principal's own wallet.

import { InvalidInputError } from '@ujira/chain-adapter';
import type { CallOptions, SignPayload, SignerRef, TenantScope } from '@ujira/chain-adapter';
import { decodeAuthEntry, decodeTransactionEnvelope } from '@ujira/chain-adapter/codecs';

import { deny } from './policy.js';
import type { PolicyContext, PolicyDecision, RefKind, ServicePolicy } from './policy.js';
import type { MandateIndex, ManagedSignerStore, PrincipalRateLimiter } from './ports.js';

/** The calls an agent exists to make. */
export const AGENT_FUNCTIONS: ReadonlySet<string> = new Set(['request_payout', 'request_payouts']);

export interface AgentPolicyOptions {
  readonly signers: ManagedSignerStore;
  readonly mandates: MandateIndex;
  readonly rateLimiter: PrincipalRateLimiter;
}

function sameTenant(a: TenantScope, b: TenantScope): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId;
}

interface AgentCall {
  /** The account the payload acts as. */
  readonly account: string;
  /** The contract it calls. */
  readonly contract: string;
}

/** The one call a payload makes, or a denial when it is anything else. */
function agentCall(ref: SignerRef, payload: SignPayload): AgentCall {
  try {
    if (payload.kind === 'stellar_tx') {
      const tx = decodeTransactionEnvelope(payload.xdr, payload.network);
      const [op] = tx.operations;
      if (
        tx.operations.length !== 1 ||
        op?.detail.kind !== 'invoke_contract' ||
        !AGENT_FUNCTIONS.has(op.detail.functionName) ||
        (op.source !== null && op.source.account !== tx.source.account)
      ) {
        throw deny(ref);
      }
      return { account: tx.source.account, contract: op.detail.contract };
    }
    if (payload.kind === 'stellar_auth_entry') {
      const entry = decodeAuthEntry(payload.entryXdr, payload.network, payload.expirationLedger);
      const call = entry.invocation;
      if (
        entry.credentials.kind !== 'address' ||
        call.kind !== 'contract_fn' ||
        !AGENT_FUNCTIONS.has(call.functionName) ||
        call.subInvocations.length !== 0
      ) {
        throw deny(ref);
      }
      return { account: entry.credentials.address, contract: call.contract };
    }
  } catch (error) {
    if (error instanceof InvalidInputError) throw deny(ref);
    throw error;
  }
  throw deny(ref);
}

export function agentPolicy(options: AgentPolicyOptions): ServicePolicy {
  const { signers, mandates, rateLimiter } = options;

  const check = async (
    ref: Extract<SignerRef, { kind: 'managed_agent' }>,
    payload: SignPayload,
    now: bigint,
    opts: CallOptions,
  ): Promise<void> => {
    const call = agentCall(ref, payload);
    const signer = await signers.active(ref.network, ref.scope, ref.agentId, opts);
    // The tags are the key manager's own record of whose key this is, so a
    // row pointing at another tenant's key is caught here.
    if (
      signer === null ||
      !sameTenant(signer.keyTags, ref.scope) ||
      signer.address !== call.account
    ) {
      throw deny(ref);
    }
    const mandate = await mandates.find(ref.network, call.contract, opts);
    if (
      mandate === null ||
      !sameTenant(mandate.tenant, ref.scope) ||
      mandate.recipientMode === 'attested'
    ) {
      throw deny(ref);
    }
    // Last, so a refused request never uses up the principal's allowance.
    if (!(await rateLimiter.take(ref.scope.principalId, now, opts))) throw deny(ref);
  };

  return {
    refKinds: new Set<RefKind>(['managed_agent']),
    async check(ref, payload, context: PolicyContext): Promise<PolicyDecision> {
      if (ref.kind !== 'managed_agent') throw deny(ref);
      await check(ref, payload, context.now, context.opts);
      return { tenant: ref.scope };
    },
  };
}
