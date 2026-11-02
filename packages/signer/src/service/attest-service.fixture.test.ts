// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The attester service against the shared attestation fixture, vendored from
 * the contracts repository at a pinned commit and checked against its hash.
 *
 * Every signed attestation in every case is read back into structured fields
 * from the bytes the fixture says were signed. The message this repository
 * builds from those fields must equal the fixture's. Through the whole
 * service (with the fixture's own test attester key, since ed25519 is
 * deterministic) the signature must equal the fixture's wherever the fixture
 * holds a good one by that key. Through the local signer it must verify over
 * that message. The policy must sign every valid case and refuse the expired
 * and over long ones, as the mandate would.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { SignerDeniedError } from '@ujira/chain-adapter';
import type {
  AttestationFields,
  Bytes32,
  NetworkId,
  SignerProvider,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { attestationMessage, encodeAccountAddress, networkIdOf } from '@ujira/chain-adapter/codecs';
import { contractAddress, ed25519Verify, hexOf } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { RemoteAttesterSigner } from '../remote-attester.js';
import { CALLER_TOKEN, OPTS, TEST_SEED, codeOf } from '../testing/service.js';
import {
  attestPolicy,
  createSignerService,
  memoryAttestationLog,
  memoryMandateIndex,
  memorySignerLogger,
} from './index.js';

const SPEC = path.resolve(import.meta.dirname, '../../spec/attestation-parity');
const FIXTURE_BYTES = readFileSync(path.join(SPEC, 'fixture.json'));
const SOURCE = JSON.parse(readFileSync(path.join(SPEC, 'SOURCE.json'), 'utf8')) as {
  readonly sha256: string;
};

interface Signed {
  readonly fields: string;
  readonly message: string;
}
interface FixtureAttestation {
  readonly valid_until: string;
  readonly signature: string;
  readonly signed: Signed;
}
interface FixtureCase {
  readonly name: string;
  readonly tamper: string | null;
  readonly now: string;
  readonly attester_public_key: string;
  readonly attestations: readonly FixtureAttestation[];
}

const FIXTURE = JSON.parse(FIXTURE_BYTES.toString('utf8')) as {
  readonly keys: { readonly attester: { readonly public_key: string } };
  readonly cases: readonly FixtureCase[];
};

const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};

const bytesOf = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));

/** The fixture's seed, derived from its public label; TEST ONLY by its own warning. */
const ATTESTER_SEED = Uint8Array.from(
  createHash('sha256').update('UJIRA/TEST-ONLY/S18/attester-ed25519').digest(),
);

// The G or C address inside Address::to_xdr bytes.
function addressOf(xdr: Uint8Array): string {
  const scAddressType = new DataView(xdr.buffer, xdr.byteOffset).getUint32(4);
  return scAddressType === 0
    ? encodeAccountAddress(xdr.subarray(12))
    : contractAddress(xdr.subarray(8));
}

/** The structured fields behind a fixture's signed bytes, or null off every known network. */
function parseFields(hex: string): AttestationFields | null {
  const bytes = bytesOf(hex);
  const view = new DataView(bytes.buffer);
  const networkHex = hexOf(bytes.subarray(0, 32));
  const networks: readonly NetworkId[] = ['stellar:testnet', 'stellar:pubnet'];
  const network = networks.find((id) => hexOf(networkIdOf(id)) === networkHex);
  if (network === undefined) return null;
  let at = 32;
  const lengthPrefixed = () => {
    const length = bytes[at] ?? 0;
    const value = bytes.subarray(at + 1, at + 1 + length);
    at += 1 + length;
    return value;
  };
  const fixed = (length: number) => {
    const value = bytes.subarray(at, at + length);
    at += length;
    return value;
  };
  const u64 = () => {
    const value = view.getBigUint64(at);
    at += 8;
    return value;
  };
  const mandate = addressOf(lengthPrefixed());
  const recipientRef = hexOf(fixed(32)) as Bytes32;
  const countryPolicyHash = hexOf(fixed(32)) as Bytes32;
  const policyEpoch = u64();
  const validUntil = u64() as UnixSeconds;
  const destination = addressOf(lengthPrefixed());
  const hasTag = fixed(1)[0] === 1;
  const tag = u64();
  return {
    mandate: { network, address: { network, value: mandate }, specVersion: 1 },
    recipientRef,
    countryPolicyHash,
    policyEpoch,
    validUntil,
    destination: { address: { network, value: destination }, tag: hasTag ? tag : null },
  };
}

// The attester key of the fixture behind the signer port.
const fixtureBackend: SignerProvider = {
  sign: (_ref, payload) => {
    if (payload.kind !== 'attestation') return Promise.reject(new SignerDeniedError());
    return Promise.resolve({
      kind: 'ed25519',
      signature: ed25519.sign(attestationMessage(payload.fields), ATTESTER_SEED),
      publicKey: ed25519.getPublicKey(ATTESTER_SEED),
    });
  },
  address: (ref) =>
    Promise.resolve({
      network: ref.network,
      value: encodeAccountAddress(ed25519.getPublicKey(ATTESTER_SEED)),
    }),
  health: () =>
    Promise.resolve({
      state: 'healthy',
      checkedAt: 0n as UnixSeconds,
      signP95Ms: null,
      reasons: [],
    }),
};

/** A service at the case's `now`, with this attestation recorded and its mandate in BOTH mode. */
function attester(backend: SignerProvider, now: string, fields: AttestationFields) {
  const app = createSignerService({
    provider: backend,
    policy: attestPolicy({
      mandates: memoryMandateIndex([
        {
          network: fields.mandate.network,
          contract: fields.mandate.address.value,
          executors: [],
          tenant: TENANT,
          recipientMode: 'both',
        },
      ]),
      log: memoryAttestationLog([
        { message: attestationMessage(fields), ...TENANT, attestationId: 'attestation-1' },
      ]),
    }),
    callers: [{ name: 'identity', token: CALLER_TOKEN }],
    logger: memorySignerLogger(),
    backendTimeoutMs: 5_000,
    now: () => new Date(Number(now) * 1000),
  });
  return new RemoteAttesterSigner({
    baseUrl: 'http://signer-attester.internal:10000',
    token: CALLER_TOKEN,
    timeoutMs: 5_000,
    fetch: (input, init) => Promise.resolve(app.fetch(new Request(input, init))),
  });
}

describe('the vendored attestation fixture', () => {
  it('matches the hash pinned with its source', () => {
    expect(createHash('sha256').update(FIXTURE_BYTES).digest('hex')).toBe(SOURCE.sha256);
  });

  it('holds the key the seed label derives', () => {
    expect(hexOf(ed25519.getPublicKey(ATTESTER_SEED))).toBe(FIXTURE.keys.attester.public_key);
  });
});

describe('the attester service against the fixture', () => {
  // The issue counted 47; the fixture at the pinned commit holds 48.
  it('holds every case', () => {
    expect(FIXTURE.cases).toHaveLength(48);
  });

  it('all 48 fixture cases match', async () => {
    const local = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
    let checked = 0;
    let identical = 0;
    for (const fixtureCase of FIXTURE.cases) {
      for (const attestation of fixtureCase.attestations) {
        const fields = parseFields(attestation.signed.fields);
        // A chain this repository does not run on cannot be asked for at all.
        if (fields === null) {
          expect(fixtureCase.tamper).toBe('wrong_chain');
          continue;
        }
        const label = fixtureCase.name;
        const expected = bytesOf(attestation.signed.message);
        expect(hexOf(attestationMessage(fields)), label).toBe(hexOf(expected));

        const validity = fields.validUntil - BigInt(fixtureCase.now);
        const inWindow = validity > 0n && validity <= 86_400n;
        const viaFixtureKey = attester(fixtureBackend, fixtureCase.now, fields);
        if (!inWindow) {
          expect(await codeOf(viaFixtureKey.signAttestation(fields, OPTS)), label).toBe(
            'SIGNER_DENIED',
          );
          continue;
        }
        const result = await viaFixtureKey.signAttestation(fields, OPTS);
        checked += 1;
        expect(result.signature, label).toHaveLength(64);
        // Wherever the fixture holds a good signature by this key, ed25519
        // being deterministic means the service must give that very one.
        const good =
          attestation.signature.length === 130 &&
          ed25519Verify(
            bytesOf(FIXTURE.keys.attester.public_key),
            expected,
            bytesOf(attestation.signature),
          );
        if (good) {
          identical += 1;
          expect(hexOf(result.signature), label).toBe(attestation.signature);
        }
        const viaLocal = await attester(local, fixtureCase.now, fields).signAttestation(
          fields,
          OPTS,
        );
        expect(ed25519Verify(viaLocal.publicKey, expected, viaLocal.signature), label).toBe(true);
      }
    }
    // Most cases are real signatures, so a loop that skipped them fails here.
    expect(checked).toBeGreaterThan(40);
    expect(identical).toBeGreaterThan(30);
  }, 180_000);

  it('signs every valid case and refuses the expired and over long ones', () => {
    const inWindow = (c: FixtureCase, a: FixtureAttestation) => {
      const validity = BigInt(a.valid_until) - BigInt(c.now);
      return validity > 0n && validity <= 86_400n;
    };
    const named = (name: string) => FIXTURE.cases.find((c) => c.name === name);
    for (const c of FIXTURE.cases.filter((x) => x.tamper === null)) {
      expect(
        c.attestations.every((a) => inWindow(c, a)),
        c.name,
      ).toBe(true);
    }
    for (const name of ['expired_at_valid_until', 'expired_after_valid_until', 'window_too_long']) {
      const c = named(name);
      const [first] = c?.attestations ?? [];
      expect(c !== undefined && first !== undefined && inWindow(c, first), name).toBe(false);
    }
  });
});
