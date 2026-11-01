// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One broken input per way each attestation check can fail, with the reason
// it must give. Breakers patch the world's current rows, so several can be
// applied together to test which check speaks first.

import type { NetworkId, UnixSeconds } from '@ujira/chain-adapter';
import { RpcTimeoutError, SignerUnavailableError } from '@ujira/chain-adapter';

import type { AttestationRefusalReason } from '../types.js';

import {
  TEST_NETWORK,
  bytes32Of,
  country,
  newId,
  railCapability,
  seedOf,
  verificationRow,
} from './fixtures.js';
import type { AttestationWorld } from './world.js';

/** The checks in the order attest runs them. */
export const ATTESTATION_STEPS = Object.freeze([
  '1',
  '2',
  '3',
  '4',
  '4a',
  '5',
  '6',
  '7',
  '8',
] as const);
export type AttestationStep = (typeof ATTESTATION_STEPS)[number];

export interface Breaker {
  readonly name: string;
  readonly step: AttestationStep;
  readonly reason: AttestationRefusalReason;
  readonly detail: string | null;
  /** Used by the order test: the breakers that compose with one per other step. */
  readonly representative: boolean;
  /** Only meaningful in this mode, when set. */
  readonly mode?: 'attested' | 'both';
  apply(world: AttestationWorld): void;
}

const OTHER_NETWORK: NetworkId = 'stellar:pubnet';

export const ATTESTATION_BREAKERS: readonly Breaker[] = Object.freeze([
  {
    name: 'the instance is paused',
    step: '1',
    reason: 'MANDATE_INACTIVE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchInstance({ status: 'paused' });
    },
  },
  {
    name: 'the instance is in allowlist mode',
    step: '1',
    reason: 'WRONG_RECIPIENT_MODE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchInstance({ recipientMode: 'allowlist' });
    },
  },
  {
    name: 'the mandate is revoked on chain',
    step: '1',
    reason: 'MANDATE_INACTIVE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchSnapshot((s) => ({ ...s, state: { ...s.state, revoked: true } }));
    },
  },
  {
    name: 'the mandate came from an untrusted factory',
    step: '1',
    reason: 'MANDATE_INACTIVE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchSnapshot((s) => ({ ...s, trustedFactory: false }));
    },
  },
  {
    name: "the mandate's tenant reference does not match",
    step: '1',
    reason: 'MANDATE_INACTIVE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchSnapshot((s) => ({ ...s, tenantRefMatches: false }));
    },
  },
  {
    name: 'the mandate is in allowlist mode on chain',
    step: '1',
    reason: 'WRONG_RECIPIENT_MODE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchSnapshot((s) => ({ ...s, config: { ...s.config, recipientMode: 'allowlist' } }));
    },
  },
  {
    name: 'the on-chain attester is another key',
    step: '1',
    reason: 'ATTESTER_MISMATCH',
    detail: null,
    representative: true,
    apply: (w) => {
      w.patchSnapshot((s) => ({ ...s, config: { ...s.config, attester: seedOf('other key') } }));
    },
  },
  {
    name: 'the mandate has no attester',
    step: '1',
    reason: 'ATTESTER_MISMATCH',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchSnapshot((s) => ({ ...s, config: { ...s.config, attester: null } }));
    },
  },
  {
    name: 'the mandate read fails',
    step: '1',
    reason: 'PROVIDER_UNAVAILABLE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.chain.readFailure = new RpcTimeoutError();
    },
  },
  {
    name: "the attester's key cannot be read",
    step: '1',
    reason: 'PROVIDER_UNAVAILABLE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.attester.keyFailure = new SignerUnavailableError();
    },
  },
  {
    name: 'the recipient is inactive',
    step: '2',
    reason: 'RECIPIENT_INACTIVE',
    detail: null,
    representative: true,
    apply: (w) => {
      w.patchRecipient({ status: 'inactive' });
    },
  },
  {
    name: 'the method is disabled',
    step: '3',
    reason: 'DESTINATION_NOT_BOUND',
    detail: null,
    representative: true,
    apply: (w) => {
      w.patchMethod({ status: 'disabled' });
    },
  },
  {
    name: 'the method belongs to another recipient',
    step: '3',
    reason: 'DESTINATION_NOT_BOUND',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchMethod({ recipientId: newId() });
    },
  },
  {
    name: 'the method is on another network',
    step: '3',
    reason: 'DESTINATION_NOT_BOUND',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchMethod({ network: OTHER_NETWORK });
    },
  },
  {
    name: 'the evidence is for another destination',
    step: '4',
    reason: 'DESTINATION_UNVERIFIED',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchMethod({ destination: { ...w.rows.method.destination, tag: 7n } });
    },
  },
  {
    name: 'the forwarder is built on an unverified wallet',
    step: '4',
    reason: 'DESTINATION_UNVERIFIED',
    detail: null,
    representative: true,
    apply: (w) => {
      w.store.putVerification(
        verificationRow(w.rows.method, {
          level: 'forwarder_derived',
          signerKey: null,
          derivedFrom: newId(),
        }),
      );
    },
  },
  {
    name: 'the principal only asserted the destination',
    step: '4',
    reason: 'DESTINATION_UNVERIFIED',
    detail: null,
    representative: false,
    mode: 'attested',
    apply: (w) => {
      w.store.putVerification(
        verificationRow(w.rows.method, { level: 'principal_asserted', signerKey: null }),
      );
    },
  },
  {
    name: 'the trustline was removed',
    step: '4a',
    reason: 'DESTINATION_NOT_RECEIVABLE',
    detail: 'NO_TRUSTLINE',
    representative: true,
    apply: (w) => {
      w.chain.destination = { receivable: false, reason: 'NO_TRUSTLINE', proofSigner: 'current' };
    },
  },
  {
    name: 'the trustline was deauthorized',
    step: '4a',
    reason: 'DESTINATION_NOT_RECEIVABLE',
    detail: 'TRUSTLINE_NOT_AUTHORIZED',
    representative: false,
    apply: (w) => {
      w.chain.destination = {
        receivable: false,
        reason: 'TRUSTLINE_NOT_AUTHORIZED',
        proofSigner: 'current',
      };
    },
  },
  {
    name: 'the proving signer was removed',
    step: '4a',
    reason: 'DESTINATION_UNVERIFIED',
    detail: 'SIGNER_NOT_CURRENT',
    representative: false,
    apply: (w) => {
      w.chain.destination = { receivable: true, proofSigner: 'not_current' };
    },
  },
  {
    name: 'the destination read fails',
    step: '4a',
    reason: 'PROVIDER_UNAVAILABLE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.chain.checkFailure = new RpcTimeoutError();
    },
  },
  {
    name: 'the identity is revoked',
    step: '5',
    reason: 'IDENTITY_REQUIRED',
    detail: 'IDENTITY_REVOKED',
    representative: false,
    apply: (w) => {
      w.patchIdentity({ status: 'revoked' });
    },
  },
  {
    name: 'the identity has expired',
    step: '5',
    reason: 'IDENTITY_REQUIRED',
    detail: 'IDENTITY_EXPIRED',
    representative: false,
    apply: (w) => {
      w.patchIdentity({ expiresAt: w.now() });
    },
  },
  {
    name: "the project needs the principal's verification, which is missing",
    step: '5',
    reason: 'IDENTITY_REQUIRED',
    detail: 'IDENTITY_REQUIRED',
    representative: true,
    apply: (w) => {
      w.store.putProjectSettings(w.scope, { recipientRequirement: 'principal_attested' });
    },
  },
  {
    name: "the method's rail is switched off",
    step: '5',
    reason: 'RAIL_UNAVAILABLE',
    detail: null,
    representative: false,
    apply: (w) => {
      w.rails.put(TEST_NETWORK, railCapability(w.rows.method.rail, { enabled: false }));
    },
  },
  {
    name: "the recipient's country is outside the policy",
    step: '6',
    reason: 'COUNTRY_NOT_ALLOWED',
    detail: null,
    representative: true,
    apply: (w) => {
      w.patchRecipient({ country: country('ZA') });
      w.patchMethod({ country: country('ZA') });
    },
  },
  {
    name: "the method's country is not the recipient's",
    step: '6',
    reason: 'COUNTRY_NOT_ALLOWED',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchMethod({ country: country('KE') });
    },
  },
  {
    name: 'the stored hash is not the hash of the stored list',
    step: '7',
    reason: 'POLICY_HASH_MISMATCH',
    detail: null,
    representative: true,
    apply: (w) => {
      w.patchInstance({ countryPolicyHash: bytes32Of('another list') });
    },
  },
  {
    name: 'the mandate holds another policy hash',
    step: '7',
    reason: 'POLICY_HASH_MISMATCH',
    detail: null,
    representative: false,
    apply: (w) => {
      w.patchSnapshot((s) => ({
        ...s,
        config: { ...s.config, countryPolicyHash: bytes32Of('another list') },
      }));
    },
  },
  {
    name: 'the identity lapses in under a minute',
    step: '8',
    reason: 'VALIDITY_TOO_SHORT',
    detail: null,
    representative: true,
    apply: (w) => {
      w.patchIdentity({ expiresAt: (w.now() + 59n) as UnixSeconds });
    },
  },
] satisfies Breaker[]);
