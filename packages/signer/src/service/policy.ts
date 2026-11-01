// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a signer service checks before it asks its backend for a signature,
// on top of the backend's own policy. Each deployment of the shared signer
// image serves a few ref kinds and applies the policy for them: the chain
// service for executors, the fee sponsor and SEP-10 keys, the agent service
// for managed agents, the attester service for the attester.

import { SignerDeniedError } from '@ujira/chain-adapter';
import type {
  CallOptions,
  SignPayload,
  SignerRef,
  TenantScope,
  UnixSeconds,
} from '@ujira/chain-adapter';

export type RefKind = SignerRef['kind'];

export interface PolicyContext {
  /** The authenticated caller's name. */
  readonly caller: string;
  readonly now: UnixSeconds;
  readonly opts: CallOptions;
}

export interface PolicyDecision {
  /** The tenant the signature is for, for the logs, or null for an infrastructure key. */
  readonly tenant: TenantScope | null;
}

export interface ServicePolicy {
  /** The ref kinds this service serves; any other is refused before the policy runs. */
  readonly refKinds: ReadonlySet<RefKind>;
  /** Resolves when the backend may sign; throws SignerDeniedError otherwise. */
  check(ref: SignerRef, payload: SignPayload, context: PolicyContext): Promise<PolicyDecision>;
}

/** A refusal for `ref`. Never says why, so a caller cannot probe the policy. */
export function deny(ref: SignerRef): SignerDeniedError {
  return new SignerDeniedError({ network: ref.network });
}

/**
 * Serves every ref kind and adds nothing to the backend's own policy. For
 * proving the transport against the conformance suite, never for a
 * deployment, which always names its own policy.
 */
export function backendOnlyPolicy(): ServicePolicy {
  return {
    refKinds: new Set<RefKind>([
      'executor',
      'fee_sponsor',
      'sep10',
      'managed_agent',
      'attester',
      'external',
    ]),
    check: () => Promise.resolve({ tenant: null }),
  };
}
