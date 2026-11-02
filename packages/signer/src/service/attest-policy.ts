// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The attester signer's policy. An attestation lets a payout reach a
// recipient on the attester's word alone, so it is signed only when two
// sides agree: the identity service recorded a pending attestation with
// this exact message first, and this service rebuilds the same message from
// the structured fields. It signs nothing but that message, only for a
// mandate that accepts attestations, and never for longer than the mandate
// would accept. With no record it refuses, which is also how it behaves
// until the attestation log exists. It never signs for an address the
// mandate could not pay out to, and that is the one refusal a caller can
// tell apart.

import { InvalidInputError } from '@ujira/chain-adapter';
import type { SignPayload, SignerRef } from '@ujira/chain-adapter';
import { attestationMessage } from '@ujira/chain-adapter/codecs';

import { refuseSettlementAsset, refuseUnpayable } from '../unpayable.js';

import { deny } from './policy.js';
import type { PolicyContext, PolicyDecision, RefKind, ServicePolicy } from './policy.js';
import type { AttestationLog, MandateIndex } from './ports.js';

/** The mandate's MAX_ATTESTATION_VALIDITY: the furthest ahead valid_until may be. */
export const MAX_ATTESTATION_VALIDITY_SECONDS = 86_400n;

export interface AttestPolicyOptions {
  readonly mandates: MandateIndex;
  readonly log: AttestationLog;
}

function messageOf(ref: SignerRef, payload: Extract<SignPayload, { kind: 'attestation' }>) {
  try {
    return attestationMessage(payload.fields);
  } catch (error) {
    if (error instanceof InvalidInputError) throw deny(ref);
    throw error;
  }
}

export function attestPolicy(options: AttestPolicyOptions): ServicePolicy {
  const { mandates, log } = options;
  return {
    refKinds: new Set<RefKind>(['attester']),
    async check(ref, payload, { now, opts }: PolicyContext): Promise<PolicyDecision> {
      if (ref.kind !== 'attester' || payload.kind !== 'attestation') throw deny(ref);
      const { fields } = payload;
      // Ahead of the layout, which refuses an M address outright: an unpayable
      // one should read as unpayable, not as malformed.
      refuseUnpayable(fields);
      const message = messageOf(ref, payload);
      // Already expired at the mandate, or valid for longer than it accepts.
      if (fields.validUntil <= now || fields.validUntil - now > MAX_ATTESTATION_VALIDITY_SECONDS) {
        throw deny(ref);
      }
      const mandate = await mandates.find(ref.network, fields.mandate.address.value, opts);
      if (mandate === null || mandate.recipientMode === 'allowlist') throw deny(ref);
      refuseSettlementAsset(fields, mandate.settlementAsset);
      const pending = await log.pending(message, opts);
      // A pending row only for this mandate's own tenant, so one tenant's
      // record can never authorize an attestation on another's mandate.
      if (
        pending?.principalId !== mandate.tenant.principalId ||
        pending.projectId !== mandate.tenant.projectId
      ) {
        throw deny(ref);
      }
      return { tenant: mandate.tenant };
    },
  };
}
