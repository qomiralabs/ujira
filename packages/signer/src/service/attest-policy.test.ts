// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the attester signer's policy (service/attest-policy.ts), run
 * through the whole service with the local backend.
 *
 * The service rebuilds the message from structured fields and signs nothing
 * else. It signs only for an indexed mandate in attested or both mode, with
 * valid_until after now and at most 24 hours ahead, when the attestation log
 * holds a pending row with the same message for the mandate's own tenant.
 * With no log row it refuses. Everything refused is SIGNER_DENIED, except a
 * destination that can never pay out, which is DESTINATION_INVALID.
 */

import { createHash } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';
import { DestinationInvalidError } from '@ujira/chain-adapter';
import type {
  AttestationFields,
  Bytes32,
  NetworkId,
  SignerRef,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { attestationMessage } from '@ujira/chain-adapter/codecs';
import { TEST_CONTRACT, TEST_DESTINATION } from '@ujira/chain-adapter/testing';
import { describe, expect, it, vi } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { RemoteAttesterSigner } from '../remote-attester.js';
import { CALLER_TOKEN, OPTS, TEST_SEED, codeOf } from '../testing/service.js';
import {
  PAYABLE,
  TEST_ASSET,
  TEST_SETTLEMENT,
  UNPAYABLE,
  UNPAYABLE_FROM_FIELDS,
} from '../testing/unpayable.js';
import { toWire } from '../wire.js';
import {
  attestPolicy,
  createSignerService,
  memoryAttestationLog,
  memoryMandateIndex,
  memorySignerLogger,
} from './index.js';
import type { RecipientMode } from './index.js';

const NETWORK: NetworkId = 'stellar:testnet';
const NOW = 1_900_000_000n;
const BASE = 'http://signer-attester.internal:10000';
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const OTHER_TENANT = { ...TENANT, projectId: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as Uuid };

function fields(validUntil = NOW + 3_600n): AttestationFields {
  return {
    mandate: {
      network: NETWORK,
      address: { network: NETWORK, value: TEST_CONTRACT },
      specVersion: 1,
    },
    recipientRef: `0x${'11'.repeat(32)}` as Bytes32,
    countryPolicyHash: `0x${'22'.repeat(32)}` as Bytes32,
    policyEpoch: 3n,
    validUntil: validUntil as UnixSeconds,
    destination: { address: { network: NETWORK, value: TEST_DESTINATION }, tag: 7n },
  };
}

interface Setup {
  readonly mode?: RecipientMode | null;
  readonly recorded?: AttestationFields | null;
  readonly logTenant?: typeof TENANT;
}

function setup(options: Setup = {}) {
  const mode = options.mode === undefined ? 'attested' : options.mode;
  const recorded = options.recorded === undefined ? fields() : options.recorded;
  const backend = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
  const app = createSignerService({
    provider: backend,
    policy: attestPolicy({
      mandates: memoryMandateIndex(
        mode === null
          ? []
          : [
              {
                network: NETWORK,
                contract: TEST_CONTRACT,
                executors: [],
                tenant: TENANT,
                recipientMode: mode,
                ...TEST_SETTLEMENT,
              },
            ],
      ),
      log: memoryAttestationLog(
        recorded === null
          ? []
          : [
              {
                message: attestationMessage(recorded),
                ...(options.logTenant ?? TENANT),
                attestationId: 'attestation-1',
              },
            ],
      ),
    }),
    callers: [{ name: 'identity', token: CALLER_TOKEN }],
    logger: memorySignerLogger(),
    backendTimeoutMs: 5_000,
    now: () => new Date(Number(NOW) * 1000),
  });
  const fetchVia: typeof fetch = (input, init) =>
    Promise.resolve(app.fetch(new Request(input, init)));
  return {
    backend,
    fetch: fetchVia,
    attester: new RemoteAttesterSigner({
      baseUrl: BASE,
      token: CALLER_TOKEN,
      timeoutMs: 5_000,
      fetch: fetchVia,
    }),
  };
}

function post(fetchVia: typeof fetch, route: string, body: unknown) {
  return fetchVia(new URL(route, BASE), {
    method: 'POST',
    headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    body: typeof body === 'string' ? body : toWire(body),
  });
}

function to(address: string, tag: bigint | null): AttestationFields {
  return { ...fields(), destination: { address: { network: NETWORK, value: address }, tag } };
}

// An M address has no message to record, since the mandate never hashes one.
// The refusal has to come first for it, and for the rest the log says yes.
const recordable = (address: string, tag: bigint | null) =>
  address.startsWith('M') ? null : to(address, tag);

describe('a destination that can never pay out', () => {
  it.each(UNPAYABLE)(
    'the service refuses %s with its own code and signs nothing',
    async (_label, address, tag) => {
      const { backend, fetch: fetchVia } = setup({ recorded: recordable(address, tag) });
      const sign = vi.spyOn(backend, 'sign');
      const response = await post(fetchVia, '/v1/attest', { fields: to(address, tag) });
      expect(response.status).toBe(422);
      expect(await response.text()).toBe('{"error":{"code":"DESTINATION_INVALID"}}');
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it.each(UNPAYABLE)(
    'a caller of the remote attester sees %s as a destination error and no signature',
    async (_label, address, tag) => {
      const { backend, attester } = setup({ recorded: recordable(address, tag) });
      const sign = vi.spyOn(backend, 'sign');
      await expect(attester.signAttestation(to(address, tag), OPTS)).rejects.toBeInstanceOf(
        DestinationInvalidError,
      );
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it.each(UNPAYABLE_FROM_FIELDS)(
    'the remote attester refuses %s without a call',
    async (_label, address, tag) => {
      const fetchVia = vi.fn<typeof fetch>();
      const remote = new RemoteAttesterSigner({
        baseUrl: BASE,
        token: CALLER_TOKEN,
        timeoutMs: 5_000,
        fetch: fetchVia,
      });
      await expect(remote.signAttestation(to(address, tag), OPTS)).rejects.toBeInstanceOf(
        DestinationInvalidError,
      );
      expect(fetchVia).not.toHaveBeenCalled();
    },
  );

  it.each(PAYABLE)('the service still signs for %s', async (_label, address, tag) => {
    const { attester } = setup({ recorded: to(address, tag) });
    const result = await attester.signAttestation(to(address, tag), OPTS);
    expect(result.signature).toHaveLength(64);
  });

  it('a mandate the index does not know is denied, whatever the destination', async () => {
    const { attester } = setup({ mode: null, recorded: to(TEST_ASSET, null) });
    expect(await codeOf(attester.signAttestation(to(TEST_ASSET, null), OPTS))).toBe(
      'SIGNER_DENIED',
    );
  });
});

describe('the attester policy', () => {
  it('output is a 64-byte ed25519 signature that verifies against the attester key over the 47-byte message', async () => {
    const { attester } = setup();
    const result = await attester.signAttestation(fields(), OPTS);
    const message = attestationMessage(fields());
    expect(message).toHaveLength(47);
    expect(result.signature).toHaveLength(64);
    expect(result.publicKey).toEqual(await attester.publicKey(NETWORK, OPTS));
    expect(ed25519.verify(result.signature, message, result.publicKey)).toBe(true);
  });

  it('signs for a mandate in both mode', async () => {
    const { attester } = setup({ mode: 'both' });
    expect(await codeOf(attester.signAttestation(fields(), OPTS))).toBe('resolved');
  });

  it('a raw message without fields is SIGNER_DENIED', async () => {
    const { fetch: fetchVia } = setup();
    const raw = createHash('sha256').update('anything').digest();
    const ref: SignerRef = { kind: 'attester', network: NETWORK };
    const attempts: [string, unknown][] = [
      ['/v1/attest', { message: raw }],
      ['/v1/attest', 'not json'],
      ['/v1/attest', { fields: { ...fields(), extra: raw } }],
      ['/v1/sign', { ref, payload: { kind: 'attestation', network: NETWORK, message: raw } }],
      ['/v1/sign', { ref, payload: { kind: 'stellar_tx', network: NETWORK, xdr: 'AAAA' } }],
    ];
    for (const [route, body] of attempts) {
      const response = await post(fetchVia, route, body);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('{"error":{"code":"SIGNER_DENIED"}}');
    }
  });

  it('valid_until beyond 24 hours is SIGNER_DENIED', async () => {
    const atLimit = fields(NOW + 86_400n);
    expect(await codeOf(setup({ recorded: atLimit }).attester.signAttestation(atLimit, OPTS))).toBe(
      'resolved',
    );
    const over = fields(NOW + 86_401n);
    expect(await codeOf(setup({ recorded: over }).attester.signAttestation(over, OPTS))).toBe(
      'SIGNER_DENIED',
    );
  });

  it('refuses a valid_until that has already passed', async () => {
    for (const validUntil of [NOW, NOW - 1n]) {
      const stale = fields(validUntil);
      expect(await codeOf(setup({ recorded: stale }).attester.signAttestation(stale, OPTS))).toBe(
        'SIGNER_DENIED',
      );
    }
  });

  it('refuses a mandate that takes no attestations, and one not indexed', async () => {
    expect(
      await codeOf(setup({ mode: 'allowlist' }).attester.signAttestation(fields(), OPTS)),
    ).toBe('SIGNER_DENIED');
    expect(await codeOf(setup({ mode: null }).attester.signAttestation(fields(), OPTS))).toBe(
      'SIGNER_DENIED',
    );
  });

  it('refuses a look-alike mandate, which is in no index, even with a pending row', async () => {
    // The index holds only what a trusted factory announced, so a contract
    // deployed directly is absent from it whatever it stores.
    const { attester } = setup({ mode: null });
    expect(await codeOf(attester.signAttestation(fields(), OPTS))).toBe('SIGNER_DENIED');
  });

  it('fails closed with no pending attestation', async () => {
    expect(await codeOf(setup({ recorded: null }).attester.signAttestation(fields(), OPTS))).toBe(
      'SIGNER_DENIED',
    );
  });

  it('refuses when what was recorded differs in any field', async () => {
    const recorded = { ...fields(), policyEpoch: 4n };
    expect(await codeOf(setup({ recorded }).attester.signAttestation(fields(), OPTS))).toBe(
      'SIGNER_DENIED',
    );
  });

  it("refuses a pending row of another tenant than the mandate's", async () => {
    expect(
      await codeOf(setup({ logTenant: OTHER_TENANT }).attester.signAttestation(fields(), OPTS)),
    ).toBe('SIGNER_DENIED');
  });

  it('refuses fields that name no real attestation', async () => {
    const bad = { ...fields(), recipientRef: '0x00' as Bytes32 };
    expect(await codeOf(setup().attester.signAttestation(bad, OPTS))).toBe('SIGNER_DENIED');
  });

  it('serves only attester refs', async () => {
    const { attester, backend } = setup();
    const executor: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };
    expect(await codeOf(attester.address(executor, OPTS))).toBe('SIGNER_DENIED');
    expect((await attester.address({ kind: 'attester', network: NETWORK }, OPTS)).value).toBe(
      (await backend.address({ kind: 'attester', network: NETWORK }, OPTS)).value,
    );
  });

  it('refuses a signature that is not over the message this side computes', async () => {
    const { backend } = setup();
    const other = await backend.sign(
      { kind: 'attester', network: NETWORK },
      { kind: 'attestation', network: NETWORK, fields: fields(NOW + 7n) },
      OPTS,
    );
    const forged = new RemoteAttesterSigner({
      baseUrl: BASE,
      token: CALLER_TOKEN,
      timeoutMs: 1_000,
      fetch: () => Promise.resolve(new Response(toWire({ signature: other }))),
    });
    expect(await codeOf(forged.signAttestation(fields(), OPTS))).toBe('SIGNER_DENIED');
    const unreadable = new RemoteAttesterSigner({
      baseUrl: BASE,
      token: CALLER_TOKEN,
      timeoutMs: 1_000,
      fetch: () => Promise.resolve(new Response('{}')),
    });
    expect(await codeOf(unreadable.signAttestation(fields(), OPTS))).toBe('SIGNER_UNAVAILABLE');
  });
});
