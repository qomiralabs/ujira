// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a caller hands the signer is checked for shape before anything else,
// because a remote client will carry it across a process boundary and the
// types alone prove nothing there. Content (a well formed envelope, a field
// in range) is checked afterwards by the codecs.

import { NETWORK_IDS, SignerDeniedError } from '@ujira/chain-adapter';
import type { AttestationFields, SignPayload, SignerRef } from '@ujira/chain-adapter';
import { z } from 'zod';

const network = z.enum(NETWORK_IDS);
const id = z.string().min(1).max(256);
const uuid = z.uuid();

const chainAddress = z.strictObject({ network, value: z.string().max(128) });

const refSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('executor'), network, keyId: id }),
  z.strictObject({ kind: z.literal('fee_sponsor'), network }),
  z.strictObject({ kind: z.literal('sep10'), network, anchorId: id }),
  z.strictObject({
    kind: z.literal('managed_agent'),
    network,
    scope: z.strictObject({ principalId: uuid, projectId: uuid }),
    agentId: uuid,
  }),
  z.strictObject({ kind: z.literal('attester'), network }),
  z.strictObject({
    kind: z.literal('external'),
    network,
    role: z.string(),
    address: chainAddress,
  }),
]);

const xdr = z.string().min(1);

export const attestationFieldsSchema = z.strictObject({
  mandate: z.strictObject({ network, address: chainAddress, specVersion: z.literal(1) }),
  recipientRef: z.string(),
  countryPolicyHash: z.string(),
  policyEpoch: z.bigint(),
  validUntil: z.bigint(),
  destination: z.strictObject({ address: chainAddress, tag: z.bigint().nullable() }),
});

const payloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stellar_tx'), network, xdr }),
  z.strictObject({ kind: z.literal('stellar_fee_bump'), network, xdr }),
  z.strictObject({
    kind: z.literal('stellar_auth_entry'),
    network,
    entryXdr: xdr,
    expirationLedger: z.int().min(1).max(0xffffffff),
  }),
  z.strictObject({ kind: z.literal('sep10_challenge'), network, xdr }),
  z.strictObject({ kind: z.literal('attestation'), network, fields: attestationFieldsSchema }),
]);

// A request the signer cannot read is one it will not sign; zod's message is
// dropped because it can quote the input.
// The schemas are strict, so input that passes holds nothing else, and it is
// returned as the port's type because zod cannot carry the port's brands.
function check(schema: z.ZodType, input: unknown): void {
  if (!schema.safeParse(input).success) throw new SignerDeniedError();
}

export function parseRef(input: unknown): SignerRef {
  check(refSchema, input);
  return input as SignerRef;
}

export function parsePayload(input: unknown): SignPayload {
  check(payloadSchema, input);
  return input as SignPayload;
}

export function parseAttestationFields(input: unknown): AttestationFields {
  check(attestationFieldsSchema, input);
  return input as AttestationFields;
}
