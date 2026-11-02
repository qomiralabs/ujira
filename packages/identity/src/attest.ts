// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The attester's check list. UJIRA's signature is what lets an attested
// mandate pay a destination, so it signs only after a fixed list of checks
// passes, in a fixed order, and only after the message it is about to sign
// is committed as pending. The signer refuses any message that is not
// pending, so both sides must agree before a signature exists.
//
// Order: (1) mandate instance, mode and attester key; (2) recipient; (3) the
// destination, read from the recipient's active payout method and never
// from the caller; (4) the destination's evidence; (4a) the destination can
// receive now, read fresh from the chain; (5) identity; (6) country; (7) the
// country policy hash; (8) validity window; (9) record, sign, mark.

import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';

import type {
  AttestationFields,
  Bytes32,
  CallOptions,
  SignatureResult,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { isChainAdapterError } from '@ujira/chain-adapter';
import { z } from 'zod';

import { MIN_ATTESTATION_VALIDITY_SECONDS, parseProjectIdentitySettings } from './config.js';
import { decideEligibility } from './eligibility.js';
import {
  AttestationMessageError,
  AttestationSigningError,
  CallTimeoutError,
  IdentityInputError,
  isIdentityError,
  issuesOf,
} from './errors.js';
import { evidenceAccepted } from './evidence.js';
import { countryAllowed, countryPolicyHash } from './policy.js';
import type { AttestationServicePorts, CheckDestinationRequest } from './ports.js';
import { assertScope, checkedScope } from './service.js';
import { withTimeout } from './timeout.js';
import type {
  AttestationRecord,
  AttestationRefusalReason,
  AttestationService,
  AttestRequest,
  AttestResult,
  EligibilityRefusalReason,
  IdentityContext,
} from './types.js';

/** The 15 byte prefix and a 32 byte SHA-256, as the mandate verifies it. */
export const ATTESTATION_MESSAGE_BYTES = 47;
const ED25519_SIGNATURE_BYTES = 64;
// DER header that turns a raw 32 byte ed25519 public key into SPKI.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Step 5 reuses the eligibility rules. Every identity answer becomes
// IDENTITY_REQUIRED with the eligibility reason as detail; the others keep
// their meaning.
const FROM_ELIGIBILITY: Readonly<Record<EligibilityRefusalReason, AttestationRefusalReason>> = {
  MANDATE_INACTIVE: 'MANDATE_INACTIVE',
  RECIPIENT_INACTIVE: 'RECIPIENT_INACTIVE',
  DESTINATION_NOT_BOUND: 'DESTINATION_NOT_BOUND',
  RAIL_UNAVAILABLE: 'RAIL_UNAVAILABLE',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  IDENTITY_REQUIRED: 'IDENTITY_REQUIRED',
  IDENTITY_PENDING: 'IDENTITY_REQUIRED',
  IDENTITY_REJECTED: 'IDENTITY_REQUIRED',
  IDENTITY_EXPIRED: 'IDENTITY_REQUIRED',
  IDENTITY_REVOKED: 'IDENTITY_REQUIRED',
};

const uuid = z.uuid();

const attestRequestSchema = z.strictObject({
  attemptId: uuid,
  legIndex: z.int().min(0).max(255),
  mandateInstanceId: uuid,
  methodId: uuid,
});

function checkedRequest(req: AttestRequest): AttestRequest {
  const parsed = attestRequestSchema.safeParse(req);
  if (!parsed.success) throw new IdentityInputError(issuesOf(parsed.error));
  return {
    attemptId: parsed.data.attemptId as Uuid,
    legIndex: parsed.data.legIndex,
    mandateInstanceId: parsed.data.mandateInstanceId as Uuid,
    methodId: parsed.data.methodId as Uuid,
  };
}

function refuse(reason: AttestationRefusalReason, detail: string | null = null): AttestResult {
  return { attested: false, reason, detail };
}

function hexOf(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

/**
 * An outage is a retryable adapter error or our own timeout, and refuses
 * with PROVIDER_UNAVAILABLE so the payout is held and tried again. Anything
 * else, including the caller giving up, is a fault and is thrown.
 */
function isOutage(error: unknown): boolean {
  return error instanceof CallTimeoutError || (isChainAdapterError(error) && error.retryable);
}

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

async function external<T>(
  ms: number,
  ctx: IdentityContext,
  run: (opts: CallOptions) => Promise<T>,
): Promise<Outcome<T>> {
  try {
    const value = await withTimeout(ms, ctx.signal, (signal) =>
      run({ correlationId: ctx.correlationId, signal }),
    );
    return { ok: true, value };
  } catch (error) {
    if (isOutage(error)) return { ok: false };
    throw error;
  }
}

function failureCodeOf(error: unknown): string {
  if (error instanceof AttestationSigningError) return error.failureCode;
  if (isChainAdapterError(error) || isIdentityError(error)) return error.code;
  return 'SIGNER_ERROR';
}

/** The signature, once it is shown to be the attester's over this message. */
function checkedSignature(
  result: SignatureResult,
  publicKey: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  if (
    result.signature.length !== ED25519_SIGNATURE_BYTES ||
    !equalBytes(result.publicKey, publicKey)
  ) {
    throw new AttestationSigningError('SIGNATURE_INVALID');
  }
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, message, key, result.signature)) {
    throw new AttestationSigningError('SIGNATURE_INVALID');
  }
  return result.signature;
}

export function createAttestationService(ports: AttestationServicePorts): AttestationService {
  return {
    async attest(ctx, rawRequest): Promise<AttestResult> {
      const scope = checkedScope(ctx);
      const req = checkedRequest(rawRequest);
      const { store } = ports;
      const config = ports.config();
      const ms = config.attestation.callTimeoutMs;

      const leg = await ports.legs.leg(scope, req.attemptId, req.legIndex);
      if (leg === null) throw new IdentityInputError(['legIndex (not_found)']);
      if (leg.mandateInstanceId !== req.mandateInstanceId) {
        throw new IdentityInputError(['mandateInstanceId (mismatch)']);
      }
      const [instance, recipient, method, identities, rawSettings, latest] = await Promise.all([
        store.mandateInstance(scope, req.mandateInstanceId),
        store.recipient(scope, leg.recipientId),
        store.payoutMethod(scope, req.methodId),
        store.identities(scope, leg.recipientId),
        store.projectSettings(scope),
        store.latestVerification(scope, req.methodId),
      ]);
      const base =
        latest?.derivedFrom == null ? null : await store.verification(scope, latest.derivedFrom);
      assertScope(scope, [leg, instance, recipient, method, latest, base, ...identities]);

      // (1) The instance is active and attested, and the key the mandate
      // checks on chain is the key the attester signs with.
      if (instance?.status !== 'active') return refuse('MANDATE_INACTIVE');
      if (instance.recipientMode === 'allowlist') return refuse('WRONG_RECIPIENT_MODE');
      const network = instance.mandate.network;
      const chain = ports.chain(network);
      const [read, key] = await Promise.all([
        external(ms, ctx, (opts) => chain.readMandate({ scope, mandate: instance.mandate }, opts)),
        external(ms, ctx, (opts) => ports.signer.publicKey(network, opts)),
      ]);
      if (!read.ok || !key.ok) return refuse('PROVIDER_UNAVAILABLE');
      const snapshot = read.value;
      const { state, config: onChain } = snapshot;
      if (
        !snapshot.trustedFactory ||
        !snapshot.tenantTagMatches ||
        state.paused ||
        state.revoked ||
        state.expired
      ) {
        return refuse('MANDATE_INACTIVE');
      }
      if (onChain.recipientMode === 'allowlist') return refuse('WRONG_RECIPIENT_MODE');
      if (onChain.attester === null || !equalBytes(onChain.attester, key.value)) {
        return refuse('ATTESTER_MISMATCH');
      }

      // (2) The leg's recipient is active.
      if (recipient?.status !== 'active') return refuse('RECIPIENT_INACTIVE');

      // (3) The destination comes from an active method of that recipient on
      // the mandate's network. The caller only names the method.
      if (
        method?.status !== 'active' ||
        method.id !== leg.methodId ||
        method.recipientId !== recipient.id ||
        method.network !== network
      ) {
        return refuse('DESTINATION_NOT_BOUND');
      }

      // (4) The method's latest evidence is accepted for the mode.
      if (
        latest === null ||
        !evidenceAccepted(onChain.recipientMode, method.destination, latest, base)
      ) {
        return refuse('DESTINATION_UNVERIFIED');
      }

      // (4a) The destination can take this leg now and the proof's signer
      // still signs for it. Read fresh every time: a trustline or a signer
      // can be removed between confirmation and attestation.
      const checkRequest: CheckDestinationRequest = {
        destination: method.destination,
        asset: snapshot.asset,
        amount: leg.amount,
        ...(latest.signerKey === null ? {} : { proofSigner: latest.signerKey }),
      };
      const checked = await external(ms, ctx, (opts) => chain.checkDestination(checkRequest, opts));
      if (!checked.ok) return refuse('PROVIDER_UNAVAILABLE');
      if (!checked.value.receivable) {
        return refuse('DESTINATION_NOT_RECEIVABLE', checked.value.reason);
      }
      if (latest.signerKey !== null && checked.value.proofSigner !== 'current') {
        return refuse('DESTINATION_UNVERIFIED', 'SIGNER_NOT_CURRENT');
      }

      // (5) The identity requirement is met and not expired.
      const now = ports.clock.nowSeconds();
      const eligibility = decideEligibility({
        instance,
        recipient,
        method,
        rail: ports.rails.rail(method.network, method.rail),
        settings: parseProjectIdentitySettings(rawSettings),
        identities,
        config,
        now,
      });
      if (!eligibility.eligible) {
        const reason = FROM_ELIGIBILITY[eligibility.reason];
        return refuse(reason, reason === 'IDENTITY_REQUIRED' ? eligibility.reason : null);
      }

      // (6) The recipient's country is in the policy and is the method's.
      if (
        !countryAllowed(instance.countryPolicy, recipient.country) ||
        recipient.country !== method.country
      ) {
        return refuse('COUNTRY_NOT_ALLOWED');
      }

      // (7) The stored list still hashes to the stored hash, and to the hash
      // the mandate holds, or the signature would be for another policy.
      const policyHash = countryPolicyHash(instance.countryPolicy.countries);
      if (policyHash !== instance.countryPolicyHash || policyHash !== onChain.countryPolicyHash) {
        return refuse('POLICY_HASH_MISMATCH');
      }

      // (8) Never outlive the identity behind it, and never sign something
      // that lapses before a payout could use it.
      const cap = now + BigInt(config.attestation.ttlSeconds);
      const expiresAt = eligibility.expiresAt;
      const validUntil = (expiresAt !== null && expiresAt < cap ? expiresAt : cap) as UnixSeconds;
      if (validUntil - now < BigInt(MIN_ATTESTATION_VALIDITY_SECONDS)) {
        return refuse('VALIDITY_TOO_SHORT');
      }

      // (9) Record what is about to be signed, then sign, then mark.
      const fields: AttestationFields = {
        mandate: instance.mandate,
        recipientRef: recipient.recipientRef,
        countryPolicyHash: policyHash,
        policyEpoch: BigInt(state.policyEpoch),
        validUntil,
        destination: method.destination,
      };
      const message = chain.attestationMessage(fields);
      if (message.length !== ATTESTATION_MESSAGE_BYTES) throw new AttestationMessageError();
      const row: AttestationRecord = {
        scope,
        id: randomUUID() as Uuid,
        attemptId: req.attemptId,
        legIndex: req.legIndex,
        mandateInstanceId: instance.id,
        recipientId: recipient.id,
        methodId: method.id,
        destination: method.destination,
        countryPolicyHash: policyHash,
        policyEpoch: fields.policyEpoch,
        validUntil,
        attesterKeyId: hexOf(key.value),
        message,
        digest: hexOf(createHash('sha256').update(message).digest()) as Bytes32,
        status: 'pending',
        signature: null,
        failureCode: null,
      };
      await ports.log.insertPending(row);

      let signature: Uint8Array;
      try {
        const result = await withTimeout(ms, ctx.signal, (signal) =>
          ports.signer.signAttestation(fields, { correlationId: ctx.correlationId, signal }),
        );
        signature = checkedSignature(result, key.value, message);
      } catch (error) {
        const failureCode = failureCodeOf(error);
        await ports.log.markFailed(scope, row.id, failureCode);
        throw error instanceof AttestationSigningError
          ? error
          : new AttestationSigningError(failureCode, { cause: error });
      }
      await ports.log.markSigned(scope, row.id, signature);

      return {
        attested: true,
        attestation: {
          id: row.id,
          legIndex: row.legIndex,
          validUntil,
          signature,
          publicKey: key.value,
          digest: row.digest,
        },
      };
    },
  };
}
