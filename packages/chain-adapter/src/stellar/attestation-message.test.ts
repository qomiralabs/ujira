// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The attestation message against the contracts' own evidence: the shared
// parity fixture, regenerated for ed25519, and the worked example in
// ENCODING.md, both vendored byte for byte at a pinned contracts commit.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidInputError } from '../errors.js';
import type { NetworkId } from '../networks.js';
import type { AttestationFields } from '../signer.js';
import { ed25519Verify } from '../testing/bytes.js';
import { parseManifest, sha256Hex } from '../testing/vectors/vendored.js';
import type { Bytes32, MandateRef, UnixSeconds } from '../types.js';

import { addressXdr } from './address-xdr.js';
import {
  ATTESTATION_MESSAGE_BYTES,
  ATTESTATION_PREFIX,
  attestationMessageOf,
  encodeAttestationFields,
  stellarAttestationMessage,
} from './attestation-message.js';
import { STELLAR_PASSPHRASES, stellarNetworkId } from './network-id.js';
import { parseStellarDestination } from './parse-destination.js';

const VENDOR_DIR = path.resolve(import.meta.dirname, '../../vendor/attestation-parity');
const read = (name: string): Uint8Array =>
  Uint8Array.from(readFileSync(path.join(VENDOR_DIR, name)));

// SHA-256 of vendor/attestation-parity/SOURCE.json, which names the
// contracts commit and holds the hash of each copied file.
const PINNED_SOURCE_SHA256 = '1eaef7a5ad6755bd0c00c0170179940c381566643db7a084758ec64104b37ee0';

function checkVendored(readFile: (name: string) => Uint8Array = read): string[] {
  const problems: string[] = [];
  const sourceBytes = readFile('SOURCE.json');
  if (sha256Hex(sourceBytes) !== PINNED_SOURCE_SHA256) problems.push('SOURCE.json: changed');
  for (const file of parseManifest(sourceBytes).files) {
    if (sha256Hex(readFile(file.path)) !== file.sha256) problems.push(`${file.path}: changed`);
  }
  return problems;
}

const hex = z.string().regex(/^0x(?:[0-9a-f]{2})*$/);
const Signed = z.object({ fields: hex, fields_sha256: hex, message: hex });
const Fixture = z.object({
  message_prefix: z.literal(ATTESTATION_PREFIX),
  message_bytes: z.literal(ATTESTATION_MESSAGE_BYTES),
  cases: z
    .array(
      z.object({
        name: z.string(),
        expect: z.string(),
        network_passphrase: z.string(),
        network_id: hex,
        mandate: z.string(),
        mandate_xdr: hex,
        attester_public_key: hex,
        recipient_ref: hex,
        country_policy_hash: hex,
        legs: z.array(
          z.object({
            destination: z.string(),
            destination_xdr: hex,
            has_tag: z.boolean(),
            tag: z.string(),
          }),
        ),
        attestations: z.array(
          z.object({
            valid_until: z.string(),
            policy_epoch: z.string(),
            signature: hex,
            signed: Signed,
            checked: Signed.nullish(),
          }),
        ),
      }),
    )
    .min(1),
});
type FixtureCase = z.infer<typeof Fixture>['cases'][number];

const fixture = Fixture.parse(JSON.parse(Buffer.from(read('fixture.json')).toString('utf8')));

const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text.slice(2), 'hex'));
const hexOf = (value: Uint8Array): string => `0x${Buffer.from(value).toString('hex')}`;

function networkOf(passphrase: string): NetworkId {
  const found = Object.entries(STELLAR_PASSPHRASES).find(([, p]) => p === passphrase);
  if (found === undefined) throw new Error(`unknown passphrase ${passphrase}`);
  return found[0] as NetworkId;
}

/** The fields the contract checks for leg `index`, from the case's inputs. */
function checkedFields(c: FixtureCase, index: number): AttestationFields | undefined {
  const leg = c.legs[index];
  const attestation = c.attestations[index];
  if (leg === undefined || attestation === undefined) return undefined;
  const network = networkOf(c.network_passphrase);
  const destination = parseStellarDestination(network, { address: leg.destination });
  expect(destination.tag, `${c.name} tag`).toBe(leg.has_tag ? BigInt(leg.tag) : null);
  const mandate: MandateRef = {
    network,
    address: { network, value: c.mandate },
    specVersion: 1,
  };
  return {
    mandate,
    recipientRef: c.recipient_ref as Bytes32,
    countryPolicyHash: c.country_policy_hash as Bytes32,
    // The epoch the attestation says it was issued under. The contract
    // hashes that one and compares it with the mandate's epoch separately,
    // which is how a stale epoch gets POLICY_CHANGED rather than a trap.
    policyEpoch: BigInt(attestation.policy_epoch),
    validUntil: BigInt(attestation.valid_until) as UnixSeconds,
    destination,
  };
}

describe('attestation message', () => {
  it('every fixture message matches', () => {
    expect(checkVendored()).toEqual([]);
    let compared = 0;
    for (const c of fixture.cases) {
      expect(hexOf(stellarNetworkId(networkOf(c.network_passphrase))), c.name).toBe(c.network_id);
      expect(hexOf(addressXdr(c.mandate)), c.name).toBe(c.mandate_xdr);
      c.attestations.forEach((attestation, index) => {
        // What the attester signed, tampered or not, hashes to its message.
        const signed = bytes(attestation.signed.fields);
        expect(hexOf(attestationMessageOf(signed)), c.name).toBe(attestation.signed.message);
        expect(`0x${sha256Hex(signed)}`, c.name).toBe(attestation.signed.fields_sha256);
        const fields = checkedFields(c, index);
        if (fields === undefined || attestation.checked == null) return;
        const leg = c.legs[index];
        expect(hexOf(addressXdr(fields.destination.address.value)), c.name).toBe(
          leg?.destination_xdr,
        );
        expect(hexOf(stellarAttestationMessage(fields)), `${c.name} leg ${String(index)}`).toBe(
          attestation.checked.message,
        );
        compared += 1;
      });
    }
    // Every case with a leg and its attestation was rebuilt, not skipped.
    expect(compared).toBeGreaterThanOrEqual(fixture.cases.length - 2);
  });

  it('fails the vendored check after one byte of the fixture changes', () => {
    const tampered = (name: string): Uint8Array => {
      const out = read(name);
      if (name === 'fixture.json') out[10] = (out[10] ?? 0) ^ 1;
      return out;
    };
    expect(checkVendored(tampered)).toEqual(['fixture.json: changed']);
  });

  it('valid fixture signatures verify and tampered ones do not', () => {
    let valid = 0;
    let tampered = 0;
    for (const c of fixture.cases) {
      const key = bytes(c.attester_public_key);
      const verifies = c.attestations.map((attestation, index) => {
        const fields = checkedFields(c, index);
        if (fields === undefined) return false;
        return ed25519Verify(key, stellarAttestationMessage(fields), bytes(attestation.signature));
      });
      if (c.expect === 'ok') {
        expect(verifies.length, c.name).toBeGreaterThan(0);
        expect(verifies.every(Boolean), c.name).toBe(true);
        valid += 1;
      } else if (c.expect === 'HOST_TRAP') {
        expect(
          verifies.some((ok) => !ok),
          c.name,
        ).toBe(true);
        tampered += 1;
      }
    }
    expect(valid).toBeGreaterThan(0);
    expect(tampered).toBeGreaterThan(0);
  });

  it("the spec's worked example", () => {
    const network: NetworkId = 'stellar:testnet';
    const fields: AttestationFields = {
      mandate: {
        network,
        address: {
          network,
          value: 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA',
        },
        specVersion: 1,
      },
      recipientRef: '0x187204dacf1b6ae9830406f0405b3710d69d86df034cf3fe3753e7b460c8e97d' as Bytes32,
      countryPolicyHash:
        '0x343fb1d75ee948735be1a836a29a40ecd0612986ab9bd1183f8271ccca830415' as Bytes32,
      policyEpoch: 0n,
      validUntil: 1_767_229_200n as UnixSeconds,
      destination: {
        address: {
          network,
          value: 'GDTYAUMMX45E2SU2Q7JRJHCXDIYTEUAXVBHZ7DVCVXZGMAKMWFL7SOY4',
        },
        tag: null,
      },
    };
    const fieldsHex =
      'cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472280000001200000001e8a94c46' +
      'ddd537ccec6c53945b5b4ee7d1a8e090df0d89115439849f6f1b8a5a187204dacf1b6ae9830406f0405b3710d6' +
      '9d86df034cf3fe3753e7b460c8e97d343fb1d75ee948735be1a836a29a40ecd0612986ab9bd1183f8271ccca83' +
      '04150000000000000000000000006955c7102c000000120000000000000000e780518cbf3a4d4a9a87d3149c57' +
      '1a31325017a84f9f8ea2adf266014cb157f9000000000000000000';
    const sha = '6786dd0154eaa55fca26d77da8952c91df2fcc0927e381771667f4c37a7f115e';
    const message = `554a4952412f4154544553542f5632${sha}`;
    const publicKey = '421adb50c10fe73fb1fc0d4211a16911a188bb001eaf0391b479316026141d48';
    const signature =
      '043dcca5e9a6dfd41320f9ecf7b4778bf00ff706ac26d865f4c1ff6366a49e04' +
      '97e63ef43e2a0e6404218231d10d11aa030f954d9eb799ff92f0328e1cae2208';

    // The example as ENCODING.md states it, so a change there fails here.
    const encoding = Buffer.from(read('ENCODING.md')).toString('utf8');
    for (const value of [fieldsHex, sha, message, publicKey, signature]) {
      expect(encoding).toContain(value);
    }

    const fieldBytes = encodeAttestationFields({
      networkId: stellarNetworkId(network),
      mandate: addressXdr(fields.mandate.address.value),
      recipientRef: bytes(fields.recipientRef),
      countryPolicyHash: bytes(fields.countryPolicyHash),
      policyEpoch: fields.policyEpoch,
      validUntil: fields.validUntil,
      destination: addressXdr(fields.destination.address.value),
      tag: null,
    });
    expect(fieldBytes).toHaveLength(207);
    expect(Buffer.from(fieldBytes).toString('hex')).toBe(fieldsHex);
    expect(sha256Hex(fieldBytes)).toBe(sha);
    const built = stellarAttestationMessage(fields);
    expect(built).toHaveLength(ATTESTATION_MESSAGE_BYTES);
    expect(Buffer.from(built).toString('hex')).toBe(message);
    expect(ed25519Verify(bytes(`0x${publicKey}`), built, bytes(`0x${signature}`))).toBe(true);
  });

  it('refuses fields the mandate could never accept', () => {
    const network: NetworkId = 'stellar:testnet';
    const c = fixture.cases[0];
    if (c === undefined) throw new Error('empty fixture');
    const good = checkedFields(c, 0);
    if (good === undefined) throw new Error('no leg');
    const refused = (fields: AttestationFields): unknown => {
      try {
        stellarAttestationMessage(fields);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const account = good.destination.address;
    for (const bad of [
      { ...good, mandate: { ...good.mandate, address: account } },
      {
        ...good,
        mandate: {
          ...good.mandate,
          address: { ...good.mandate.address, network: 'stellar:pubnet' },
        },
      },
      {
        ...good,
        destination: { ...good.destination, address: { ...account, network: 'stellar:pubnet' } },
      },
      { ...good, recipientRef: '0x12' as Bytes32 },
      { ...good, countryPolicyHash: `0x${'A'.repeat(64)}` as Bytes32 },
      { ...good, policyEpoch: -1n },
      { ...good, validUntil: (1n << 64n) as UnixSeconds },
      { ...good, destination: { ...good.destination, tag: 1n << 64n } },
      {
        ...good,
        destination: { ...good.destination, address: { network, value: 'MNOTANADDRESS' } },
      },
    ] as AttestationFields[]) {
      expect(refused(bad)).toBeInstanceOf(InvalidInputError);
    }
    expect(stellarAttestationMessage(good)).toHaveLength(ATTESTATION_MESSAGE_BYTES);
  });

  it('keeps no tag apart from a tag of zero', () => {
    const c = fixture.cases[0];
    const good = c === undefined ? undefined : checkedFields(c, 0);
    if (good === undefined) throw new Error('no leg');
    const none = stellarAttestationMessage({
      ...good,
      destination: { ...good.destination, tag: null },
    });
    const zero = stellarAttestationMessage({
      ...good,
      destination: { ...good.destination, tag: 0n },
    });
    expect(hexOf(none)).not.toBe(hexOf(zero));
  });
});
