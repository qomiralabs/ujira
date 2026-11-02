// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A signer service logs the ref kind, network, payload kind, payload hash,
// tenant ids, caller, route, status, error code and timing, and nothing
// else: no payload body, no recipient destination, no token, no signature
// and no key material, on success or on refusal.

import type { SignPayload, SignerProvider, SignerRef, Uuid } from '@ujira/chain-adapter';
import { decodeFeeBumpEnvelope } from '@ujira/chain-adapter/codecs';
import {
  TEST_CONTRACT,
  TEST_DESTINATION,
  testFeeBumpXdr,
  testInvokeXdr,
  testReserveSandwichXdr,
  testTransactionXdr,
} from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { CALLER_TOKEN, OPTS, TEST_SEED, codeOf, harness } from '../testing/service.js';
import {
  SIGNER_LOG_FIELDS,
  backendOnlyPolicy,
  chainPolicy,
  memoryMandateIndex,
  memorySponsorshipLedger,
} from './index.js';

const NETWORK = 'stellar:testnet';
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const EXECUTOR: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };
const SPONSOR: SignerRef = { kind: 'fee_sponsor', network: NETWORK };
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';

describe('the key manager request id', () => {
  it('goes in the log and not back to the caller', async () => {
    const keys = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
    const backend: SignerProvider = {
      sign: async (ref, payload, opts) => ({
        ...(await keys.sign(ref, payload, opts)),
        requestId: 'kms-request-1',
      }),
      address: (ref, opts) => keys.address(ref, opts),
      health: (opts) => keys.health(opts),
    };
    const service = harness({ policy: backendOnlyPolicy(), provider: backend });
    const source = (await keys.address(EXECUTOR, OPTS)).value;
    const payload: SignPayload = {
      kind: 'stellar_tx',
      network: NETWORK,
      xdr: testTransactionXdr({ source }),
    };

    const result = await service.remote.sign(EXECUTOR, payload, OPTS);

    expect(result).not.toHaveProperty('requestId');
    expect(service.records[0]).toMatchObject({ event: 'sign_ok', keyRequestId: 'kms-request-1' });
  });

  it('is left out of the log when the backend has none', async () => {
    const keys = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
    const service = harness({ policy: backendOnlyPolicy(), provider: keys });
    const source = (await keys.address(EXECUTOR, OPTS)).value;
    await service.remote.sign(
      EXECUTOR,
      { kind: 'stellar_tx', network: NETWORK, xdr: testTransactionXdr({ source }) },
      OPTS,
    );
    expect(service.records[0]).not.toHaveProperty('keyRequestId');
  });
});

describe('signer service logs', () => {
  it('captured logs contain only the allowed fields', async () => {
    const keys = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
    const executor = (await keys.address(EXECUTOR, OPTS)).value;
    const sponsor = (await keys.address(SPONSOR, OPTS)).value;
    const bumpXdr = testFeeBumpXdr({ feeSource: sponsor, innerSource: TEST_DESTINATION });
    const bump = decodeFeeBumpEnvelope(bumpXdr, NETWORK);
    const service = harness({
      nowSeconds: 1_900_000_000,
      policy: chainPolicy({
        mandates: memoryMandateIndex([
          {
            network: NETWORK,
            contract: TEST_CONTRACT,
            executors: [executor],
            tenant: TENANT,
            recipientMode: 'allowlist',
          },
        ]),
        sponsorships: memorySponsorshipLedger([
          {
            network: NETWORK,
            txHash: bump.inner.hash,
            intent: 'fee_bump',
            tenant: TENANT,
            maxFeeStroops: 10_000n,
          },
        ]),
        networks: {
          [NETWORK]: {
            executorMaxFeeStroops: 10_000n,
            sponsorMaxFeeStroops: 10_000n,
            payoutAsset: { code: 'USDC', issuer: ISSUER },
            sep10: {},
          },
        },
      }),
    });
    const execute: SignPayload = {
      kind: 'stellar_tx',
      network: NETWORK,
      xdr: testInvokeXdr({
        source: executor,
        calls: [{ contract: TEST_CONTRACT, functionName: 'execute' }],
      }),
    };
    const sandwich: SignPayload = {
      kind: 'stellar_reserve_sandwich',
      network: NETWORK,
      xdr: testReserveSandwichXdr({
        sponsor,
        sponsored: TEST_DESTINATION,
        asset: { code: 'USDC', issuer: ISSUER },
      }),
    };
    const signatures = [
      await service.remote.sign(EXECUTOR, execute, OPTS),
      await service.remote.sign(
        SPONSOR,
        { kind: 'stellar_fee_bump', network: NETWORK, xdr: bumpXdr },
        OPTS,
      ),
    ];
    // Refused for want of a reservation, after the destination was read.
    expect(await codeOf(service.remote.sign(SPONSOR, sandwich, OPTS))).toBe('SIGNER_DENIED');
    expect(await codeOf(service.stranger.sign(EXECUTOR, execute, OPTS))).toBe('SIGNER_DENIED');
    await service.remote.address(EXECUTOR, OPTS);
    await service.remote.health(OPTS);

    const allowed = new Set<string>([...SIGNER_LOG_FIELDS, 'time', 'level', 'event', 'requestId']);
    expect(service.records.length).toBe(6);
    for (const record of service.records) {
      expect(Object.keys(record).filter((key) => !allowed.has(key))).toEqual([]);
    }
    expect(service.records.map((r) => r.event)).toEqual([
      'sign_ok',
      'sign_ok',
      'request_refused',
      'auth_refused',
      'address_ok',
      'health_ok',
    ]);
    expect(service.records[0]).toMatchObject({
      caller: 'payouts',
      refKind: 'executor',
      network: NETWORK,
      payloadKind: 'stellar_tx',
      principalId: TENANT.principalId,
      projectId: TENANT.projectId,
      status: 200,
    });
    expect(service.records[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);

    const text = JSON.stringify(service.records);
    const secrets = [
      TEST_DESTINATION,
      executor,
      sponsor,
      execute.xdr,
      sandwich.xdr,
      bumpXdr,
      CALLER_TOKEN,
      TEST_SEED,
      ...signatures.flatMap((s) => [
        Buffer.from(s.signature).toString('base64'),
        Buffer.from(s.signature).toString('hex'),
        Buffer.from(s.publicKey).toString('hex'),
      ]),
    ];
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});
