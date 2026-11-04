// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { UnixSeconds } from '@ujira/chain-adapter';
import {
  DestinationInvalidError,
  RpcTimeoutError,
  SignerDeniedError,
  SignerUnavailableError,
  TenantMismatchError,
} from '@ujira/chain-adapter';
import {
  deployMandate,
  ed25519PublicKey,
  ed25519Verify,
  fakeAdapterHarness,
  hexOf,
  mandateTenantTag,
  sha256,
} from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { ATTESTATION_MESSAGE_BYTES, createAttestationService } from './attest.js';
import { parseIdentityConfig } from './config.js';
import {
  AttestationConflictError,
  AttestationMessageError,
  AttestationSigningError,
  CallAbortedError,
  IdentityInputError,
} from './errors.js';
import { createIdentityService } from './service.js';
import {
  LocalAttester,
  TEST_ATTESTER_SEED,
  TEST_NETWORK,
  TEST_NOW,
  WALLET_RAIL,
  attestationWorld,
  contractOf,
  methodRow,
  newId,
  newScope,
  railCapability,
  verificationRow,
} from './testing/index.js';
import type { AttestationWorld } from './testing/index.js';
import type { AttestResult, SignedAttestation } from './types.js';

const ALL_ON = {
  providers: { self: { enabled: true }, sep12: { enabled: true }, principal: { enabled: true } },
};

function attested(result: AttestResult): SignedAttestation {
  if (!result.attested) throw new Error(`refused with ${result.reason}`);
  return result.attestation;
}

async function signingFailure(w: AttestationWorld): Promise<AttestationSigningError> {
  const error = await w.attest().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AttestationSigningError);
  return error as AttestationSigningError;
}

function onlyRow(w: AttestationWorld) {
  const rows = w.log.rows(w.scope);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('no row');
  return row;
}

describe('a clean attestation', () => {
  it('is an ed25519 signature by the attester over the 47 byte message, recorded as signed', async () => {
    const w = attestationWorld();
    const attestation = attested(await w.attest());
    const row = onlyRow(w);

    expect(row.message).toHaveLength(ATTESTATION_MESSAGE_BYTES);
    expect(Buffer.from(row.message.subarray(0, 15)).toString('ascii')).toBe('UJIRA/ATTEST/V2');
    expect(attestation.publicKey).toEqual(ed25519PublicKey(TEST_ATTESTER_SEED));
    expect(ed25519Verify(attestation.publicKey, row.message, attestation.signature)).toBe(true);
    expect(row.status).toBe('signed');
    expect(row.signature).toEqual(attestation.signature);
    expect(row.digest).toBe(hexOf(sha256(row.message)));
    expect(attestation.digest).toBe(row.digest);
    expect(row.attesterKeyId).toBe(hexOf(attestation.publicKey));
    expect(attestation.legIndex).toBe(w.rows.leg.legIndex);
    expect(attestation.id).toBe(row.id);

    // The signer was handed the fields and rebuilt the same message.
    const [fields] = w.attester.signed;
    if (fields === undefined) throw new Error('nothing signed');
    expect(w.chain.attestationMessage(fields)).toEqual(row.message);
    expect(fields).toEqual({
      mandate: w.rows.instance.mandate,
      recipientRef: w.rows.recipient.recipientRef,
      countryPolicyHash: w.rows.instance.countryPolicyHash,
      policyEpoch: 3n,
      validUntil: attestation.validUntil,
      destination: w.rows.method.destination,
    });
    expect(w.log.events.map((event) => event.split(' ')[0])).toEqual([
      'insert',
      'commit',
      'signed',
    ]);
  });

  it('lasts the configured window, capped by the identity expiry', async () => {
    const full = attestationWorld();
    expect(attested(await full.attest()).validUntil).toBe(TEST_NOW + 86_400n);

    const short = attestationWorld();
    short.setConfig({ attestation: { ttlSeconds: 120, callTimeoutMs: 150 } });
    expect(attested(await short.attest()).validUntil).toBe(TEST_NOW + 120n);

    const capped = attestationWorld();
    const expiry = (TEST_NOW + 600n) as UnixSeconds;
    capped.patchIdentity({ expiresAt: expiry });
    expect(attested(await capped.attest()).validUntil).toBe(expiry);

    // Exactly a minute left is still enough.
    const edge = attestationWorld();
    edge.patchIdentity({ expiresAt: (TEST_NOW + 60n) as UnixSeconds });
    expect(attested(await edge.attest()).validUntil).toBe(TEST_NOW + 60n);
  });

  it('reads the destination fresh on every attestation', async () => {
    const w = attestationWorld();
    attested(await w.attest());
    expect(w.chain.checks).toEqual([
      {
        destination: w.rows.method.destination,
        asset: 'USDC',
        amount: w.rows.leg.amount,
        proofSigner: w.verification.signerKey,
      },
    ]);
    w.clock.set((TEST_NOW + 1n) as UnixSeconds);
    w.chain.destination = { receivable: false, reason: 'TRUSTLINE_LIMIT', proofSigner: 'current' };
    expect(await w.attest()).toEqual({
      attested: false,
      reason: 'DESTINATION_NOT_RECEIVABLE',
      detail: 'TRUSTLINE_LIMIT',
    });
    expect(w.chain.checks).toHaveLength(2);
    expect(w.chain.reads).toHaveLength(2);
  });
});

describe('a look-alike mandate', () => {
  const OPTS = { correlationId: 'look-alike' };

  // The factory's code deployed directly: its stored facts match and its tag is
  // valid for this tenant, so the only thing against it is that no trusted
  // factory announced it. The refusal comes from the real adapter's rules.
  it('is refused before anything is recorded or signed', async () => {
    const h = fakeAdapterHarness();
    const m = await deployMandate(h);
    const net = h.world.net;
    const address = net.contract('look-alike');
    const snap = await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS);
    net.deployDirect(address, {
      principal: m.principal.value,
      asset: net.token.address,
      recipientMode: 'ATTESTED',
      tenantTag: mandateTenantTag(h.scope, address),
      agents: [h.managedAgent.address.value],
      approvers: [],
      approvalsRequired: 0,
      guardians: [],
      executors: [],
      recovery: [],
      recoveryThreshold: 0,
      limits: {
        totalBudget: 10n,
        perPaymentCap: 10n,
        perRecipientDailyCap: 10n,
        approvalThreshold: 11n,
        payoutTtlSeconds: 3_600n,
        expiresAt: snap.config.limits.expiresAt,
      },
      attester: new Uint8Array(32).fill(7),
      countryPolicyHash: snap.config.countryPolicyHash,
      maxFeeBps: 0,
    });
    const lookAlike = { ...m.ref, address: { network: net.network, value: address } };
    const refusal: unknown = await h.adapter
      .readMandate({ scope: h.scope, mandate: lookAlike }, OPTS)
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'MANDATE_UNTRUSTED' });

    const w = attestationWorld();
    w.chain.readFailure = refusal as Error;
    expect(await w.attest()).toEqual({
      attested: false,
      reason: 'MANDATE_INACTIVE',
      detail: 'MANDATE_UNTRUSTED',
    });
    expect(w.log.rows(w.scope)).toEqual([]);
    expect(w.attester.signed).toEqual([]);
  });
});

describe('the pending row comes first', () => {
  it('signer is called only after the pending row commits', async () => {
    const w = attestationWorld();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.log.beforeCommit = () => held;

    const running = w.attest();
    await expect.poll(() => w.log.events.length).toBe(1);
    // Give the service every chance to call the signer early.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(w.attester.signed).toEqual([]);
    expect(w.log.events[0]).toMatch(/^insert /);

    release();
    attested(await running);
    expect(w.attester.signed).toHaveLength(1);
    expect(w.log.events.map((event) => event.split(' ')[0])).toEqual([
      'insert',
      'commit',
      'signed',
    ]);
  });

  it('the attester refuses a message that is not pending, and the row is marked failed', async () => {
    const w = attestationWorld();
    const denying = new LocalAttester({
      messageOf: (fields) => w.chain.attestationMessage(fields),
      isPending: () => false,
    });
    const service = createAttestationService({
      store: w.store,
      rails: w.rails,
      clock: w.clock,
      config: () => parseIdentityConfig(ALL_ON),
      chain: () => w.chain,
      signer: denying,
      log: w.log,
      legs: w.legs,
    });
    const error = await service.attest(w.ctx, w.request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttestationSigningError);
    expect((error as AttestationSigningError).failureCode).toBe('SIGNER_DENIED');
    expect((error as Error).cause).toBeInstanceOf(SignerDeniedError);
    expect(onlyRow(w)).toMatchObject({ status: 'failed', failureCode: 'SIGNER_DENIED' });
  });

  it('the same message cannot be logged twice', async () => {
    const w = attestationWorld();
    attested(await w.attest());
    await expect(w.attest()).rejects.toThrow(AttestationConflictError);
    expect(w.attester.signed).toHaveLength(1);
  });

  it('a message that is not 47 bytes is never logged or signed', async () => {
    const w = attestationWorld();
    w.chain.attestationMessage = () => new Uint8Array(46);
    await expect(w.attest()).rejects.toThrow(AttestationMessageError);
    expect(w.log.events).toEqual([]);
    expect(w.attester.signed).toEqual([]);
  });
});

describe('a destination the attester refuses as unpayable', () => {
  it('is a refusal and not a signing failure, with the row failed and nothing signed', async () => {
    const w = attestationWorld();
    w.attester.signFailure = new DestinationInvalidError();
    expect(await w.attest()).toEqual({
      attested: false,
      reason: 'DESTINATION_NOT_RECEIVABLE',
      detail: 'DESTINATION_UNPAYABLE',
    });
    expect(w.attester.signed).toEqual([]);
    expect(onlyRow(w)).toMatchObject({ status: 'failed', failureCode: 'DESTINATION_INVALID' });
  });
});

describe('signing failures mark the row failed', () => {
  it('an unavailable attester', async () => {
    const w = attestationWorld();
    w.attester.signFailure = new SignerUnavailableError();
    const error = await signingFailure(w);
    expect(error.failureCode).toBe('SIGNER_UNAVAILABLE');
    expect(error.cause).toBeInstanceOf(SignerUnavailableError);
    expect(onlyRow(w)).toMatchObject({ status: 'failed', failureCode: 'SIGNER_UNAVAILABLE' });
  });

  it('an attester that hangs past the timeout', async () => {
    const w = attestationWorld();
    w.attester.signFailure = 'hang';
    expect((await signingFailure(w)).failureCode).toBe('IDENTITY_CALL_TIMEOUT');
    expect(onlyRow(w).status).toBe('failed');
  });

  it('an unexpected attester error', async () => {
    const w = attestationWorld();
    w.attester.signFailure = new Error('socket closed');
    const error = await signingFailure(w);
    expect(error.failureCode).toBe('SIGNER_ERROR');
    expect(error.message).not.toContain('socket');
  });

  it('a signature that does not verify, is short, or is by another key', async () => {
    const tampers = [
      (r: { signature: Uint8Array }) => ({
        ...r,
        signature: r.signature.map((b, i) => (i === 0 ? b ^ 1 : b)),
      }),
      (r: { signature: Uint8Array }) => ({ ...r, signature: r.signature.subarray(0, 63) }),
      (r: { signature: Uint8Array }) => ({
        ...r,
        publicKey: ed25519PublicKey(sha256(r.signature)),
      }),
    ];
    for (const tamper of tampers) {
      const w = attestationWorld();
      w.attester.tamper = (result) => ({ ...result, ...tamper(result) });
      expect((await signingFailure(w)).failureCode).toBe('SIGNATURE_INVALID');
      expect(onlyRow(w)).toMatchObject({ status: 'failed', signature: null });
    }
  });
});

describe('step 3', () => {
  it('disabled method gives DESTINATION_NOT_BOUND', async () => {
    const w = attestationWorld();
    const identity = createIdentityService({
      store: w.store,
      rails: w.rails,
      clock: w.clock,
      config: () => parseIdentityConfig(ALL_ON),
    });
    const eligibility = await identity.eligibility(w.ctx, {
      recipientId: w.rows.recipient.id,
      methodId: w.rows.method.id,
      mandateInstanceId: w.rows.instance.id,
    });
    expect(eligibility.eligible).toBe(true);

    w.patchMethod({ status: 'disabled' });
    expect(await w.attest()).toEqual({
      attested: false,
      reason: 'DESTINATION_NOT_BOUND',
      detail: null,
    });
    expect(w.log.events).toEqual([]);
    expect(w.attester.signed).toEqual([]);
  });

  it("a method other than the leg's is not bound, even the recipient's own verified one", async () => {
    const w = attestationWorld();
    const other = methodRow(w.scope, w.rows.recipient.id);
    w.store.putPayoutMethod(other).putVerification(verificationRow(other));
    expect(await w.service.attest(w.ctx, { ...w.request, methodId: other.id })).toEqual({
      attested: false,
      reason: 'DESTINATION_NOT_BOUND',
      detail: null,
    });
  });
});

describe('step 4', () => {
  it('forwarder_derived on a wallet_session wallet attests, on an unverified wallet does not', async () => {
    const forwarder = {
      address: { network: TEST_NETWORK, value: contractOf('forwarder') },
      tag: null,
    };

    const onSession = attestationWorld();
    const wallet = methodRow(onSession.scope, onSession.rows.recipient.id);
    const session = verificationRow(wallet, { level: 'wallet_session', signerKey: null });
    onSession.store.putPayoutMethod(wallet).putVerification(session);
    onSession.patchMethod({ destination: forwarder });
    onSession.store.putVerification(
      verificationRow(onSession.rows.method, {
        level: 'forwarder_derived',
        signerKey: null,
        derivedFrom: session.id,
      }),
    );
    const attestation = attested(await onSession.attest());
    expect(onlyRow(onSession).destination).toEqual(forwarder);
    expect(attestation.signature).toHaveLength(64);
    // A forwarder has no proof signer of its own to check.
    expect(onSession.chain.checks[0]).not.toHaveProperty('proofSigner');

    const onUnverified = attestationWorld();
    onUnverified.patchMethod({ destination: forwarder });
    onUnverified.store.putVerification(
      verificationRow(onUnverified.rows.method, {
        level: 'forwarder_derived',
        signerKey: null,
        derivedFrom: newId(),
      }),
    );
    expect(await onUnverified.attest()).toEqual({
      attested: false,
      reason: 'DESTINATION_UNVERIFIED',
      detail: null,
    });
    expect(onUnverified.log.events).toEqual([]);
  });

  it('a method with no evidence at all is unverified', async () => {
    const w = attestationWorld({ verified: false });
    expect(await w.attest()).toEqual({
      attested: false,
      reason: 'DESTINATION_UNVERIFIED',
      detail: null,
    });
    expect(w.chain.checks).toEqual([]);
  });
});

describe('step 4a catches changes after confirmation', () => {
  const cases = [
    [
      'the trustline is removed',
      { receivable: false, reason: 'NO_TRUSTLINE', proofSigner: 'current' },
      'DESTINATION_NOT_RECEIVABLE',
      'NO_TRUSTLINE',
    ],
    [
      'the trustline is deauthorized',
      { receivable: false, reason: 'TRUSTLINE_NOT_AUTHORIZED', proofSigner: 'current' },
      'DESTINATION_NOT_RECEIVABLE',
      'TRUSTLINE_NOT_AUTHORIZED',
    ],
    [
      'the proving signer is removed',
      { receivable: true, proofSigner: 'not_current' },
      'DESTINATION_UNVERIFIED',
      'SIGNER_NOT_CURRENT',
    ],
    [
      'the proof signer is no longer applicable',
      { receivable: true, proofSigner: 'not_applicable' },
      'DESTINATION_UNVERIFIED',
      'SIGNER_NOT_CURRENT',
    ],
  ] as const;

  it.each(cases)(
    '%s: refused at 4a with no attestations row',
    async (_name, check, reason, detail) => {
      const w = attestationWorld();
      w.chain.destination = check;
      expect(await w.attest()).toEqual({ attested: false, reason, detail });
      expect(w.chain.checks).toHaveLength(1);
      expect(w.log.events).toEqual([]);
      expect(w.log.rows(w.scope)).toEqual([]);
      expect(w.attester.signed).toEqual([]);
    },
  );

  it('an RPC timeout gives PROVIDER_UNAVAILABLE and no signature', async () => {
    const w = attestationWorld();
    w.chain.checkFailure = 'hang';
    expect(await w.attest()).toEqual({
      attested: false,
      reason: 'PROVIDER_UNAVAILABLE',
      detail: null,
    });
    expect(w.log.events).toEqual([]);
    expect(w.attester.signed).toEqual([]);
  });

  it('an RPC error gives PROVIDER_UNAVAILABLE and no signature', async () => {
    const w = attestationWorld();
    w.chain.checkFailure = new RpcTimeoutError();
    expect(await w.attest()).toMatchObject({ attested: false, reason: 'PROVIDER_UNAVAILABLE' });
    expect(w.attester.signed).toEqual([]);
  });
});

describe('faults are thrown, not refused', () => {
  it('a caller that gives up mid call', async () => {
    const w = attestationWorld();
    w.chain.checkFailure = 'hang';
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new Error('client went away'));
    }, 10);
    w.setConfig({ attestation: { callTimeoutMs: 60_000 } });
    await expect(
      w.service.attest({ ...w.ctx, signal: controller.signal }, w.request),
    ).rejects.toThrow(CallAbortedError);
    expect(w.log.events).toEqual([]);
  });

  it('a chain error that is not an outage', async () => {
    const w = attestationWorld();
    w.chain.readFailure = new TenantMismatchError();
    await expect(w.attest()).rejects.toThrow(TenantMismatchError);
  });

  it('a malformed request, a leg that does not exist, and a leg of another instance', async () => {
    const w = attestationWorld();
    const tooBig = await w.service
      .attest(w.ctx, { ...w.request, legIndex: 256 })
      .catch((e: unknown) => e);
    expect((tooBig as IdentityInputError).issues).toEqual(['legIndex (too_big)']);

    const missing = await w.service
      .attest(w.ctx, { ...w.request, attemptId: newId() })
      .catch((e: unknown) => e);
    expect((missing as IdentityInputError).issues).toEqual(['legIndex (not_found)']);

    const elsewhere = await w.service
      .attest(w.ctx, { ...w.request, mandateInstanceId: newId() })
      .catch((e: unknown) => e);
    expect((elsewhere as IdentityInputError).issues).toEqual(['mandateInstanceId (mismatch)']);
  });

  it("another tenant cannot attest this tenant's leg", async () => {
    const w = attestationWorld();
    await expect(
      w.service.attest({ scope: newScope(), correlationId: 'intruder' }, w.request),
    ).rejects.toThrow(IdentityInputError);
    expect(w.log.events).toEqual([]);
    expect(w.chain.reads).toEqual([]);
  });
});

describe('step 5 keeps the eligibility meaning', () => {
  it('a rail switched off is RAIL_UNAVAILABLE with no detail', async () => {
    const w = attestationWorld();
    w.rails.put(TEST_NETWORK, railCapability(WALLET_RAIL, { enabled: false }));
    expect(await w.attest()).toEqual({ attested: false, reason: 'RAIL_UNAVAILABLE', detail: null });
  });

  it('a provider switched off is PROVIDER_UNAVAILABLE', async () => {
    const w = attestationWorld();
    w.setConfig({ providers: { self: { enabled: false } } });
    expect(await w.attest()).toEqual({
      attested: false,
      reason: 'PROVIDER_UNAVAILABLE',
      detail: null,
    });
  });
});
