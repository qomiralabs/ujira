// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The suite every signer backend must pass before it can stand behind the
// port. It signs real Stellar payloads for whatever accounts the backend's
// keys control, attaches the signatures, reads the envelopes back through
// the codecs and verifies each signature independently of the backend.
// Attestations are checked against the in-memory mandate's own encoding,
// which is the contract's. Nothing here reaches a network.

import { ed25519 } from '@noble/curves/ed25519.js';
import type {
  AttestationFields,
  AttesterSigner,
  Bytes32,
  CallOptions,
  NetworkId,
  SignPayload,
  SignatureResult,
  SignerProvider,
  SignerRef,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import {
  attachAuthEntrySignature,
  attachEnvelopeSignature,
  decodeAccountAddress,
  decodeAuthEntry,
  decodeFeeBumpEnvelope,
  decodeTransactionEnvelope,
  networkIdOf,
} from '@ujira/chain-adapter/codecs';
import {
  TEST_CONTRACT,
  TEST_DESTINATION,
  TEST_INNER_SOURCE,
  attestationMessage as mandateAttestationMessage,
  testAuthEntryXdr,
  testFeeBumpXdr,
  testReserveSandwichXdr,
  testSep10ChallengeXdr,
  testTransactionXdr,
} from '@ujira/chain-adapter/testing';
import { beforeAll, describe, expect, it } from 'vitest';

export interface SignerBackend {
  readonly provider: SignerProvider;
  readonly attester: AttesterSigner;
}

const NETWORK: NetworkId = 'stellar:testnet';
const OPTS: CallOptions = { correlationId: 'signer-conformance' };
const LEDGER = 2_000_000;
const ATTESTATIONS = 200;

const SCOPE = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const OTHER_SCOPE = { ...SCOPE, projectId: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as Uuid };
const AGENT = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' as Uuid;

const EXECUTOR: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };
const SPONSOR: SignerRef = { kind: 'fee_sponsor', network: NETWORK };
const SEP10: SignerRef = { kind: 'sep10', network: NETWORK, anchorId: 'anchor.example' };
const AGENT_REF: SignerRef = {
  kind: 'managed_agent',
  network: NETWORK,
  scope: SCOPE,
  agentId: AGENT,
};
// The same agent ID under another tenant, which must be another key.
const OTHER_TENANT_AGENT: SignerRef = {
  kind: 'managed_agent',
  network: NETWORK,
  scope: OTHER_SCOPE,
  agentId: AGENT,
};
const ATTESTER: SignerRef = { kind: 'attester', network: NETWORK };

function attestation(i: number): AttestationFields {
  const tag = i % 3 === 0 ? null : BigInt(i);
  return {
    mandate: {
      network: NETWORK,
      address: { network: NETWORK, value: TEST_CONTRACT },
      specVersion: 1,
    },
    recipientRef: `0x${i.toString(16).padStart(64, '0')}` as Bytes32,
    countryPolicyHash: `0x${'5a'.repeat(32)}` as Bytes32,
    policyEpoch: BigInt(i % 7),
    validUntil: BigInt(1_900_000_000 + i) as UnixSeconds,
    destination: {
      address: { network: NETWORK, value: i % 2 === 0 ? TEST_DESTINATION : TEST_CONTRACT },
      tag,
    },
  };
}

// The message as the mandate builds it, from the engine and not the codecs,
// so a backend and the codecs cannot agree on a wrong layout.
function mandateMessage(fields: AttestationFields): Uint8Array {
  return mandateAttestationMessage({
    networkId: networkIdOf(fields.mandate.network),
    mandate: fields.mandate.address.value,
    recipientRef: fields.recipientRef,
    countryPolicyHash: fields.countryPolicyHash,
    policyEpoch: fields.policyEpoch,
    validUntil: fields.validUntil,
    destination: { address: fields.destination.address.value, tag: fields.destination.tag },
  });
}

function expectRaw(result: SignatureResult): void {
  // Exactly the port's fields: no DER, recovery ID or vendor envelope.
  expect(Object.keys(result).sort()).toEqual(['kind', 'publicKey', 'signature']);
  expect(result.kind).toBe('ed25519');
  expect(result.signature).toBeInstanceOf(Uint8Array);
  expect(result.signature).toHaveLength(64);
  expect(result.publicKey).toHaveLength(32);
}

// The code a call fails with. One that resolves reports "resolved", which no
// expected code equals.
async function codeOf(run: Promise<unknown>): Promise<unknown> {
  const outcome = await run.then(
    () => ({ code: 'resolved' }),
    (error: unknown) => error as { code?: unknown },
  );
  return outcome.code;
}

function only<T>(list: readonly T[]): T {
  expect(list).toHaveLength(1);
  return list[0] as T;
}

/** Registers the conformance suite for one backend; `factory` runs once. */
export function describeSignerProvider(
  name: string,
  factory: () => SignerBackend | Promise<SignerBackend>,
): void {
  describe(`signer conformance: ${name}`, () => {
    let provider: SignerProvider;
    let attester: AttesterSigner;
    const accountOf = async (ref: SignerRef): Promise<string> =>
      (await provider.address(ref, OPTS)).value;

    beforeAll(async () => {
      ({ provider, attester } = await factory());
    });

    it('signs a testnet transaction hash, and the attached signature verifies after re-parsing', async () => {
      const source = await accountOf(EXECUTOR);
      const xdr = testTransactionXdr({ source, network: NETWORK });
      const result = await provider.sign(
        EXECUTOR,
        { kind: 'stellar_tx', network: NETWORK, xdr },
        OPTS,
      );
      expectRaw(result);
      const signed = decodeTransactionEnvelope(attachEnvelopeSignature(xdr, result), NETWORK);
      const sig = only(signed.signatures);
      expect(sig.hint).toEqual(result.publicKey.slice(28));
      expect(ed25519.verify(sig.signature, signed.hash, decodeAccountAddress(source))).toBe(true);
    });

    it('signs a fee bump as the fee sponsor', async () => {
      const feeSource = await accountOf(SPONSOR);
      const xdr = testFeeBumpXdr({ feeSource, network: NETWORK });
      const result = await provider.sign(
        SPONSOR,
        { kind: 'stellar_fee_bump', network: NETWORK, xdr },
        OPTS,
      );
      expectRaw(result);
      const signed = decodeFeeBumpEnvelope(attachEnvelopeSignature(xdr, result), NETWORK);
      const sig = only(signed.signatures);
      expect(ed25519.verify(sig.signature, signed.hash, decodeAccountAddress(feeSource))).toBe(
        true,
      );
    });

    it('signs a reserve sandwich as the fee sponsor, and refuses one it is not the source of', async () => {
      const sponsor = await accountOf(SPONSOR);
      const asset = { code: 'USDC', issuer: TEST_INNER_SOURCE };
      const xdr = testReserveSandwichXdr({ sponsor, sponsored: TEST_DESTINATION, asset });
      const payload: SignPayload = { kind: 'stellar_reserve_sandwich', network: NETWORK, xdr };
      const result = await provider.sign(SPONSOR, payload, OPTS);
      expectRaw(result);
      const signed = decodeTransactionEnvelope(attachEnvelopeSignature(xdr, result), NETWORK);
      expect(ed25519.verify(result.signature, signed.hash, decodeAccountAddress(sponsor))).toBe(
        true,
      );
      const foreign = testReserveSandwichXdr({
        sponsor: TEST_INNER_SOURCE,
        sponsored: TEST_DESTINATION,
        asset,
      });
      expect(
        await codeOf(
          provider.sign(
            SPONSOR,
            { kind: 'stellar_reserve_sandwich', network: NETWORK, xdr: foreign },
            OPTS,
          ),
        ),
      ).toBe('SIGNER_DENIED');
      expect(await codeOf(provider.sign(EXECUTOR, { ...payload }, OPTS))).toBe('SIGNER_DENIED');
    });

    it('signs an authorization entry for its own address', async () => {
      for (const ref of [EXECUTOR, AGENT_REF]) {
        const address = await accountOf(ref);
        const entryXdr = testAuthEntryXdr({ address });
        const payload: SignPayload = {
          kind: 'stellar_auth_entry',
          network: NETWORK,
          entryXdr,
          expirationLedger: LEDGER,
        };
        const result = await provider.sign(ref, payload, OPTS);
        expectRaw(result);
        const signed = decodeAuthEntry(
          attachAuthEntrySignature(entryXdr, result, LEDGER),
          NETWORK,
          LEDGER,
        );
        expect(signed.credentials).toMatchObject({
          signed: true,
          signatureExpirationLedger: LEDGER,
        });
        expect(
          ed25519.verify(
            result.signature,
            signed.hash ?? new Uint8Array(32),
            decodeAccountAddress(address),
          ),
        ).toBe(true);
      }
    });

    it('signs a SEP-10 challenge as the client', async () => {
      const client = await accountOf(SEP10);
      const xdr = testSep10ChallengeXdr({ server: TEST_INNER_SOURCE, client, network: NETWORK });
      const result = await provider.sign(
        SEP10,
        { kind: 'sep10_challenge', network: NETWORK, xdr },
        OPTS,
      );
      const signed = decodeTransactionEnvelope(attachEnvelopeSignature(xdr, result), NETWORK);
      expect(ed25519.verify(result.signature, signed.hash, decodeAccountAddress(client))).toBe(
        true,
      );
    });

    it(`signs ${String(ATTESTATIONS)} attestation messages, each verifying against the key's public key`, async () => {
      const publicKey = await attester.publicKey(NETWORK, OPTS);
      expect(publicKey).toEqual(decodeAccountAddress(await accountOf(ATTESTER)));
      for (let i = 0; i < ATTESTATIONS; i += 1) {
        const fields = attestation(i);
        const result = await attester.signAttestation(fields, OPTS);
        expectRaw(result);
        expect(result.publicKey).toEqual(publicKey);
        expect(ed25519.verify(result.signature, mandateMessage(fields), publicKey)).toBe(true);
      }
      // The same key through the provider port gives the same signature.
      const fields = attestation(1);
      const viaPort = await provider.sign(
        ATTESTER,
        { kind: 'attestation', network: NETWORK, fields },
        OPTS,
      );
      expect(viaPort.signature).toEqual((await attester.signAttestation(fields, OPTS)).signature);
      // Two hundred signatures and two verifications each, which a remote
      // backend or a coverage run cannot fit in the default five seconds.
    }, 120_000);

    it('address agrees with every signature', async () => {
      const executor = await accountOf(EXECUTOR);
      const tx = await provider.sign(
        EXECUTOR,
        { kind: 'stellar_tx', network: NETWORK, xdr: testTransactionXdr({ source: executor }) },
        OPTS,
      );
      expect(tx.publicKey).toEqual(decodeAccountAddress(executor));
      const sponsor = await accountOf(SPONSOR);
      const bump = await provider.sign(
        SPONSOR,
        { kind: 'stellar_fee_bump', network: NETWORK, xdr: testFeeBumpXdr({ feeSource: sponsor }) },
        OPTS,
      );
      expect(bump.publicKey).toEqual(decodeAccountAddress(sponsor));
      expect((await provider.address(EXECUTOR, OPTS)).network).toBe(NETWORK);
    });

    it('gives each ref its own key, and each tenant its own agent key', async () => {
      const accounts = await Promise.all(
        [
          EXECUTOR,
          { ...EXECUTOR, keyId: 'executor_1' },
          { ...EXECUTOR, network: 'stellar:pubnet' },
          SPONSOR,
          SEP10,
          { ...SEP10, anchorId: 'other.example' },
          AGENT_REF,
          OTHER_TENANT_AGENT,
          ATTESTER,
        ].map((ref) => accountOf(ref as SignerRef)),
      );
      expect(new Set(accounts).size).toBe(accounts.length);
      expect(await accountOf(EXECUTOR)).toBe(accounts[0]);
    });

    it("refuses a payload whose signer is another account, including another tenant's agent", async () => {
      const xdr = testTransactionXdr({ source: TEST_INNER_SOURCE });
      expect(
        await codeOf(provider.sign(EXECUTOR, { kind: 'stellar_tx', network: NETWORK, xdr }, OPTS)),
      ).toBe('SIGNER_DENIED');
      const other = await accountOf(OTHER_TENANT_AGENT);
      const entryXdr = testAuthEntryXdr({ address: other });
      const payload: SignPayload = {
        kind: 'stellar_auth_entry',
        network: NETWORK,
        entryXdr,
        expirationLedger: LEDGER,
      };
      expect(await codeOf(provider.sign(AGENT_REF, payload, OPTS))).toBe('SIGNER_DENIED');
      const bump = testFeeBumpXdr({ feeSource: TEST_INNER_SOURCE });
      expect(
        await codeOf(
          provider.sign(SPONSOR, { kind: 'stellar_fee_bump', network: NETWORK, xdr: bump }, OPTS),
        ),
      ).toBe('SIGNER_DENIED');
    });

    it("refuses a key asked to do another key's job", async () => {
      const sponsorTx = testTransactionXdr({ source: await accountOf(SPONSOR) });
      const attesterTx = testTransactionXdr({ source: await accountOf(ATTESTER) });
      const sep10Tx = testTransactionXdr({ source: await accountOf(SEP10) });
      const cases: [SignerRef, SignPayload][] = [
        [SPONSOR, { kind: 'stellar_tx', network: NETWORK, xdr: sponsorTx }],
        [ATTESTER, { kind: 'stellar_tx', network: NETWORK, xdr: attesterTx }],
        [SEP10, { kind: 'stellar_tx', network: NETWORK, xdr: sep10Tx }],
        [EXECUTOR, { kind: 'attestation', network: NETWORK, fields: attestation(1) }],
        [EXECUTOR, { kind: 'sep10_challenge', network: NETWORK, xdr: sponsorTx }],
      ];
      for (const [ref, payload] of cases) {
        expect(await codeOf(provider.sign(ref, payload, OPTS))).toBe('SIGNER_DENIED');
      }
    });

    it('refuses an external ref, a network mismatch and an unreadable payload', async () => {
      const source = await accountOf(EXECUTOR);
      const external: SignerRef = {
        kind: 'external',
        network: NETWORK,
        role: 'recovery',
        address: { network: NETWORK, value: source },
      };
      const xdr = testTransactionXdr({ source });
      expect(
        await codeOf(provider.sign(external, { kind: 'stellar_tx', network: NETWORK, xdr }, OPTS)),
      ).toBe('SIGNER_DENIED');
      expect(await codeOf(provider.address(external, OPTS))).toBe('SIGNER_DENIED');
      expect(
        await codeOf(
          provider.sign(EXECUTOR, { kind: 'stellar_tx', network: 'stellar:pubnet', xdr }, OPTS),
        ),
      ).toBe('SIGNER_DENIED');
      expect(
        await codeOf(
          provider.sign(EXECUTOR, { kind: 'stellar_tx', network: NETWORK, xdr: 'AAAA' }, OPTS),
        ),
      ).toBe('SIGNER_DENIED');
      const mismatched = {
        ...attestation(2),
        mandate: {
          ...attestation(2).mandate,
          network: 'stellar:pubnet' as const,
          address: { network: 'stellar:pubnet' as const, value: TEST_CONTRACT },
        },
      };
      expect(
        await codeOf(
          provider.sign(
            ATTESTER,
            { kind: 'attestation', network: NETWORK, fields: mismatched },
            OPTS,
          ),
        ),
      ).toBe('SIGNER_DENIED');
      expect(
        await codeOf(
          provider.sign(
            ATTESTER,
            {
              kind: 'attestation',
              network: NETWORK,
              fields: { ...attestation(2), recipientRef: '0x00' as Bytes32 },
            },
            OPTS,
          ),
        ),
      ).toBe('SIGNER_DENIED');
    });

    it('refuses a SEP-10 challenge that could be applied, or that it is not the client of', async () => {
      const client = await accountOf(SEP10);
      const cases = [
        // The client as the transaction source: a transaction it would pay for.
        testSep10ChallengeXdr({ server: client, client }),
        // Another account logging in.
        testSep10ChallengeXdr({ server: TEST_INNER_SOURCE, client: TEST_DESTINATION }),
        // A sequence that can be applied.
        testTransactionXdr({ source: TEST_INNER_SOURCE, operationSource: client }),
      ];
      for (const xdr of cases) {
        expect(
          await codeOf(
            provider.sign(SEP10, { kind: 'sep10_challenge', network: NETWORK, xdr }, OPTS),
          ),
        ).toBe('SIGNER_DENIED');
      }
    });

    it('signs nothing for a caller that has given up', async () => {
      const controller = new AbortController();
      controller.abort();
      const opts: CallOptions = { ...OPTS, signal: controller.signal };
      const xdr = testTransactionXdr({ source: await accountOf(EXECUTOR) });
      expect(
        await codeOf(provider.sign(EXECUTOR, { kind: 'stellar_tx', network: NETWORK, xdr }, opts)),
      ).toBe('SIGNER_UNAVAILABLE');
      expect(await codeOf(attester.signAttestation(attestation(3), opts))).toBe(
        'SIGNER_UNAVAILABLE',
      );
    });

    it('reports its health', async () => {
      const health = await provider.health(OPTS);
      expect(['healthy', 'degraded', 'down']).toContain(health.state);
      expect(typeof health.checkedAt).toBe('bigint');
      expect(health.signP95Ms === null || health.signP95Ms >= 0).toBe(true);
    });
  });
}
