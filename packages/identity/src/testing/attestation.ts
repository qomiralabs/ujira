// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Stand-ins for the attestation side: the attestation log, the payouts
// service's legs, the chain calls the attester makes and a local attester.
// The fake chain builds the real 47 byte message with the chain adapter's
// test encoder, and the local attester signs it with a real ed25519 key, so
// a test can verify the signature exactly as the mandate would.

import type {
  AttestationFields,
  AttesterSigner,
  MandateRef,
  MandateSnapshot,
  SignatureResult,
  TenantScope,
  Uuid,
} from '@ujira/chain-adapter';
import { SignerDeniedError } from '@ujira/chain-adapter';
import {
  TESTNET_PASSPHRASE,
  attestationMessage,
  ed25519PublicKey,
  ed25519Sign,
  sha256,
} from '@ujira/chain-adapter/testing';

import { AttestationConflictError, AttestationStateError } from '../errors.js';
import type {
  AttestationChain,
  AttestationLog,
  CheckDestinationRequest,
  DestinationCheck,
  PayoutLegSource,
} from '../ports.js';
import type { AttemptLegRecord, AttestationRecord } from '../types.js';

import { tenantKey } from './memory-store.js';

/**
 * The spec's published test attester: the seed is the SHA-256 of a public
 * label, so anyone can rebuild it. Never configure it outside tests.
 */
export const TEST_ATTESTER_SEED = sha256(
  new TextEncoder().encode('UJIRA/TEST-ONLY/S18/attester-ed25519'),
);

function hexOf(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

/** A promise that never settles, for a call that hangs and ignores its signal. */
function hang<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** What a fake call does instead of answering: fail with an error, or hang. */
export type FakeFailure = Error | 'hang';

function failOrAnswer<T>(failure: FakeFailure | null, answer: () => T): Promise<T> {
  if (failure === 'hang') return hang();
  if (failure !== null) return Promise.reject(failure);
  return Promise.resolve(answer());
}

export class InMemoryPayoutLegs implements PayoutLegSource {
  readonly #legs = new Map<string, AttemptLegRecord>();

  put(row: AttemptLegRecord): this {
    this.#legs.set(`${tenantKey(row.scope)}/${row.attemptId}/${String(row.legIndex)}`, row);
    return this;
  }

  leg(scope: TenantScope, attemptId: Uuid, legIndex: number): Promise<AttemptLegRecord | null> {
    return Promise.resolve(
      this.#legs.get(`${tenantKey(scope)}/${attemptId}/${String(legIndex)}`) ?? null,
    );
  }
}

/**
 * The attestation table as the planned trigger and unique index keep it:
 * unique on digest and key, and status leaves pending once. `beforeCommit`
 * lets a test hold an insert open to see who acts before it commits.
 */
export class InMemoryAttestationLog implements AttestationLog {
  readonly #rows = new Map<string, AttestationRecord>();
  /** insert, commit, signed and failed, with the row id, in the order they happened. */
  readonly events: string[] = [];
  beforeCommit: (() => Promise<void>) | null = null;

  async insertPending(row: AttestationRecord): Promise<void> {
    this.events.push(`insert ${row.id}`);
    for (const existing of this.#rows.values()) {
      if (existing.digest === row.digest && existing.attesterKeyId === row.attesterKeyId) {
        throw new AttestationConflictError();
      }
    }
    if (this.beforeCommit !== null) await this.beforeCommit();
    this.#rows.set(`${tenantKey(row.scope)}/${row.id}`, row);
    this.events.push(`commit ${row.id}`);
  }

  markSigned(scope: TenantScope, attestationId: Uuid, signature: Uint8Array): Promise<void> {
    return this.#leavePending(scope, attestationId, 'signed', { signature });
  }

  markFailed(scope: TenantScope, attestationId: Uuid, failureCode: string): Promise<void> {
    return this.#leavePending(scope, attestationId, 'failed', { failureCode });
  }

  #leavePending(
    scope: TenantScope,
    attestationId: Uuid,
    status: 'signed' | 'failed',
    patch: Partial<AttestationRecord>,
  ): Promise<void> {
    const key = `${tenantKey(scope)}/${attestationId}`;
    const row = this.#rows.get(key);
    if (row?.status !== 'pending') return Promise.reject(new AttestationStateError());
    this.#rows.set(key, { ...row, ...patch, status });
    this.events.push(`${status} ${attestationId}`);
    return Promise.resolve();
  }

  /**
   * What the signer asks before it signs: is this exact message pending
   * under this key? Answered across tenants, as the signer holds no tenant.
   */
  isPending(message: Uint8Array, attesterKeyId: string): boolean {
    return [...this.#rows.values()].some(
      (row) =>
        row.status === 'pending' &&
        row.attesterKeyId === attesterKeyId &&
        sameBytes(row.message, message),
    );
  }

  rows(scope: TenantScope): AttestationRecord[] {
    const tenant = tenantKey(scope);
    return [...this.#rows.values()].filter((row) => tenantKey(row.scope) === tenant);
  }
}

/** The chain calls the attester makes, answered from fields a test sets. */
export class FakeAttestationChain implements AttestationChain {
  snapshot: MandateSnapshot;
  readFailure: FakeFailure | null = null;
  destination: DestinationCheck = { receivable: true, proofSigner: 'current' };
  checkFailure: FakeFailure | null = null;
  /** Every checkDestination request, so a test can see each was a fresh read. */
  readonly checks: CheckDestinationRequest[] = [];
  readonly reads: MandateRef[] = [];
  readonly #networkId: Uint8Array;

  constructor(snapshot: MandateSnapshot, networkPassphrase: string = TESTNET_PASSPHRASE) {
    this.snapshot = snapshot;
    this.#networkId = sha256(new TextEncoder().encode(networkPassphrase));
  }

  readMandate(req: {
    readonly scope: TenantScope;
    readonly mandate: MandateRef;
  }): Promise<MandateSnapshot> {
    this.reads.push(req.mandate);
    return failOrAnswer(this.readFailure, () => this.snapshot);
  }

  attestationMessage(fields: AttestationFields): Uint8Array {
    return attestationMessage({
      networkId: this.#networkId,
      mandate: fields.mandate.address.value,
      recipientRef: fields.recipientRef,
      countryPolicyHash: fields.countryPolicyHash,
      policyEpoch: fields.policyEpoch,
      validUntil: fields.validUntil,
      destination: { address: fields.destination.address.value, tag: fields.destination.tag },
    });
  }

  checkDestination(req: CheckDestinationRequest): Promise<DestinationCheck> {
    this.checks.push(req);
    return failOrAnswer(this.checkFailure, () => this.destination);
  }
}

export interface LocalAttesterOptions {
  readonly seed?: Uint8Array;
  /** How the attester lays out the message, the same way the adapter does. */
  readonly messageOf: (fields: AttestationFields) => Uint8Array;
  /** Whether the message is pending under the key. Fails closed when it is not. */
  readonly isPending: (message: Uint8Array, attesterKeyId: string) => boolean;
}

/**
 * A local AttesterSigner with a real ed25519 key. Like the attester service,
 * it rebuilds the message from the fields and signs only a pending one.
 */
export class LocalAttester implements AttesterSigner {
  readonly publicKeyBytes: Uint8Array;
  readonly signed: AttestationFields[] = [];
  signFailure: FakeFailure | null = null;
  keyFailure: FakeFailure | null = null;
  /** Replaces the result, to test what the service does with a bad one. */
  tamper: ((result: SignatureResult) => SignatureResult) | null = null;
  readonly #seed: Uint8Array;
  readonly #options: LocalAttesterOptions;

  constructor(options: LocalAttesterOptions) {
    this.#seed = options.seed ?? TEST_ATTESTER_SEED;
    this.publicKeyBytes = ed25519PublicKey(this.#seed);
    this.#options = options;
  }

  publicKey(): Promise<Uint8Array> {
    return failOrAnswer(this.keyFailure, () => this.publicKeyBytes);
  }

  signAttestation(fields: AttestationFields): Promise<SignatureResult> {
    if (this.signFailure === 'hang') return hang();
    if (this.signFailure !== null) return Promise.reject(this.signFailure);
    const message = this.#options.messageOf(fields);
    if (!this.#options.isPending(message, hexOf(this.publicKeyBytes))) {
      return Promise.reject(new SignerDeniedError());
    }
    this.signed.push(fields);
    const result: SignatureResult = {
      kind: 'ed25519',
      signature: ed25519Sign(this.#seed, message),
      publicKey: this.publicKeyBytes,
    };
    return Promise.resolve(this.tamper === null ? result : this.tamper(result));
  }
}
