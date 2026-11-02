// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The attester service logs the same closed set of fields as every signer
// service, with the mandate's tenant, and no recipient reference, destination,
// tag, token, signature or key, on success or on refusal.

import type { AttestationFields, Bytes32, UnixSeconds, Uuid } from '@ujira/chain-adapter';
import { attestationMessage } from '@ujira/chain-adapter/codecs';
import { TEST_CONTRACT, TEST_DESTINATION } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { RemoteAttesterSigner } from '../remote-attester.js';
import { CALLER_TOKEN, OPTS, TEST_SEED, codeOf } from '../testing/service.js';
import {
  SIGNER_LOG_FIELDS,
  attestPolicy,
  createSignerService,
  memoryAttestationLog,
  memoryMandateIndex,
  memorySignerLogger,
} from './index.js';

const NETWORK = 'stellar:testnet';
const NOW = 1_900_000_000n;
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const RECIPIENT_REF = `0x${'11'.repeat(32)}`;
const TAG = 990_077_123n;

const fields = (policyEpoch: bigint): AttestationFields => ({
  mandate: {
    network: NETWORK,
    address: { network: NETWORK, value: TEST_CONTRACT },
    specVersion: 1,
  },
  recipientRef: RECIPIENT_REF as Bytes32,
  countryPolicyHash: `0x${'22'.repeat(32)}` as Bytes32,
  policyEpoch,
  validUntil: (NOW + 3_600n) as UnixSeconds,
  destination: { address: { network: NETWORK, value: TEST_DESTINATION }, tag: TAG },
});

describe('attester service logs', () => {
  it('captured logs contain only the allowed fields', async () => {
    const logger = memorySignerLogger();
    const app = createSignerService({
      provider: new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' }),
      policy: attestPolicy({
        mandates: memoryMandateIndex([
          {
            network: NETWORK,
            contract: TEST_CONTRACT,
            executors: [],
            tenant: TENANT,
            recipientMode: 'attested',
          },
        ]),
        log: memoryAttestationLog([
          { message: attestationMessage(fields(1n)), ...TENANT, attestationId: 'attestation-1' },
        ]),
      }),
      callers: [{ name: 'identity', token: CALLER_TOKEN }],
      logger,
      backendTimeoutMs: 5_000,
      now: () => new Date(Number(NOW) * 1000),
    });
    const attester = new RemoteAttesterSigner({
      baseUrl: 'http://signer-attester.internal:10000',
      token: CALLER_TOKEN,
      timeoutMs: 5_000,
      fetch: (input, init) => Promise.resolve(app.fetch(new Request(input, init))),
    });
    const signature = await attester.signAttestation(fields(1n), OPTS);
    // Refused after the fields were read: nothing recorded for this epoch.
    expect(await codeOf(attester.signAttestation(fields(2n), OPTS))).toBe('SIGNER_DENIED');

    const allowed = new Set<string>([...SIGNER_LOG_FIELDS, 'time', 'level', 'event', 'requestId']);
    for (const record of logger.records) {
      expect(Object.keys(record).filter((key) => !allowed.has(key))).toEqual([]);
    }
    expect(logger.records.map((r) => r.event)).toEqual(['sign_ok', 'request_refused']);
    expect(logger.records[0]).toMatchObject({
      caller: 'identity',
      route: '/v1/attest',
      refKind: 'attester',
      payloadKind: 'attestation',
      principalId: TENANT.principalId,
      projectId: TENANT.projectId,
    });

    const text = JSON.stringify(logger.records);
    for (const secret of [
      TEST_DESTINATION,
      TEST_CONTRACT,
      RECIPIENT_REF,
      RECIPIENT_REF.slice(2),
      TAG.toString(),
      CALLER_TOKEN,
      TEST_SEED,
      Buffer.from(signature.signature).toString('base64'),
      Buffer.from(signature.publicKey).toString('hex'),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
