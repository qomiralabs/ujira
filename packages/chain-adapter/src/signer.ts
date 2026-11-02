// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The port every key UJIRA holds signs through: executor channel accounts,
// the fee sponsor, SEP-10 logins, opted in agent keys and the attester.
// Callers hand it a typed intent and get raw ed25519 bytes back, so no key
// manager's encoding (DER, recovery IDs, vendor envelopes) reaches the
// adapter, and the backend behind it changes by configuration alone.
// Keys appear in configuration only as pinned references, and each pin is
// checked against address() before a service takes any work.

import type { NetworkId } from './networks.js';
import type {
  Bytes32,
  CallOptions,
  ChainAddress,
  Destination,
  HealthState,
  MandateRef,
  RoleName,
  TenantScope,
  UnixSeconds,
  Uuid,
} from './types.js';

/**
 * What a recipient attestation covers, as the mandate checks it. The signer
 * lays the message out from these fields itself and signs nothing else, so
 * it can never be handed bytes it did not build.
 */
export interface AttestationFields {
  /** Its network gives the network ID the message is bound to. */
  readonly mandate: MandateRef;
  readonly recipientRef: Bytes32;
  readonly countryPolicyHash: Bytes32;
  /** The mandate's policy epoch the attestation is issued under, a u64. */
  readonly policyEpoch: bigint;
  readonly validUntil: UnixSeconds;
  /** The leg's base address and tag. No tag and a tag of zero attest different things. */
  readonly destination: Destination;
}

/**
 * What to sign. Stellar payloads are base64 XDR that the signer decodes and
 * checks against its policy for the ref before any key is used.
 */
export type SignPayload =
  | {
      /** A transaction a UJIRA account is the source of, such as an executor's execute call. */
      readonly kind: 'stellar_tx';
      readonly network: NetworkId;
      readonly xdr: string;
    }
  | {
      /** The fee sponsor's outer envelope around a principal's signed transaction. */
      readonly kind: 'stellar_fee_bump';
      readonly network: NetworkId;
      readonly xdr: string;
    }
  | {
      /**
       * The fee sponsor's own transaction that opens or activates an account
       * with its reserves sponsored: begin sponsoring, optionally create the
       * account, add the payout asset's trust line, end sponsoring.
       */
      readonly kind: 'stellar_reserve_sandwich';
      readonly network: NetworkId;
      readonly xdr: string;
    }
  | {
      readonly kind: 'stellar_auth_entry';
      readonly network: NetworkId;
      readonly entryXdr: string;
      /** The last ledger the signature is valid for. */
      readonly expirationLedger: number;
    }
  | {
      /** An anchor's challenge transaction; the anchor comes from the sep10 ref. */
      readonly kind: 'sep10_challenge';
      readonly network: NetworkId;
      readonly xdr: string;
    }
  | {
      readonly kind: 'attestation';
      /** Must be the mandate's network. */
      readonly network: NetworkId;
      readonly fields: AttestationFields;
    };

/** Raw ed25519, verified by the provider against the public key before it returns. */
export interface Ed25519Signature {
  readonly kind: 'ed25519';
  /** 64 bytes, R then S, as RFC 8032 lays them out. */
  readonly signature: Uint8Array;
  /** The 32 byte public key that made it. */
  readonly publicKey: Uint8Array;
}

/**
 * A signature as it crosses the port. One scheme today, as a union so a
 * second one is a new member and not a change to every caller.
 */
export type SignatureResult = Ed25519Signature;

/**
 * Mandate roles whose keys UJIRA never holds, and the principal. Executors
 * are UJIRA's own channel accounts and sign through the executor ref.
 */
export type ExternalSignerRole = 'principal' | Exclude<RoleName, 'executor'>;

/**
 * Which key signs. Every kind but external names a key UJIRA holds, which
 * the signer service resolves from its own configuration.
 */
export type SignerRef =
  /** The key of a leased channel account, taken from the lease so two jobs never share one. */
  | { readonly kind: 'executor'; readonly network: NetworkId; readonly keyId: string }
  | { readonly kind: 'fee_sponsor'; readonly network: NetworkId }
  /** UJIRA's key for logging in to one anchor. */
  | { readonly kind: 'sep10'; readonly network: NetworkId; readonly anchorId: string }
  /**
   * An agent key UJIRA holds for a principal who opted in. The tenant is
   * part of the ref, so a key can only ever be asked for on its own
   * tenant's behalf.
   */
  | {
      readonly kind: 'managed_agent';
      readonly network: NetworkId;
      readonly scope: TenantScope;
      readonly agentId: Uuid;
    }
  | { readonly kind: 'attester'; readonly network: NetworkId }
  /**
   * A member's own wallet, which signs outside UJIRA from a SigningRequest.
   * Recovery actions name a recovery member here. A provider refuses it
   * with SignerDeniedError, since there is no key to use.
   */
  | {
      readonly kind: 'external';
      readonly network: NetworkId;
      readonly role: ExternalSignerRole;
      readonly address: ChainAddress;
    };

export interface SignerHealth {
  readonly state: HealthState;
  readonly checkedAt: UnixSeconds;
  /** Signing latency over the recent window, or null before the first signature. */
  readonly signP95Ms: number | null;
  /** Machine codes such as THROTTLED or KEY_DISABLED. */
  readonly reasons: readonly string[];
}

/**
 * Implemented in the signer package: locally for development and tests, by
 * a remote client everywhere else. Failures are SignerUnavailableError,
 * SignerDeniedError or SignerAddressMismatchError, never a vendor's error.
 */
export interface SignerProvider {
  sign(ref: SignerRef, payload: SignPayload, opts: CallOptions): Promise<SignatureResult>;
  /** The account the ref's key controls, derived from the key and never read from configuration. */
  address(ref: SignerRef, opts: CallOptions): Promise<ChainAddress>;
  health(opts: CallOptions): Promise<SignerHealth>;
}

/** The recipient attester whose signatures mandates in attested mode check. */
export interface AttesterSigner {
  signAttestation(fields: AttestationFields, opts: CallOptions): Promise<SignatureResult>;
  /** The 32 byte ed25519 key the network's mandates are configured with. */
  publicKey(network: NetworkId, opts: CallOptions): Promise<Uint8Array>;
}
