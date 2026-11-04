// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The agent service logs the same closed set of fields as every signer
// service, with the tenant the key belongs to, and no payload, account,
// token, signature or key, on success or on refusal.

import type { SignPayload, SignerRef, Uuid } from '@ujira/chain-adapter';
import { TEST_CONTRACT, testInvokeXdr } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { LocalSigner } from '../local-signer.js';
import { CALLER_TOKEN, OPTS, TEST_SEED, codeOf, harness } from '../testing/service.js';
import { TEST_SETTLEMENT } from '../testing/unpayable.js';
import {
  SIGNER_LOG_FIELDS,
  agentPolicy,
  memoryManagedSignerStore,
  memoryMandateIndex,
  memoryRateLimiter,
} from './index.js';

const NETWORK = 'stellar:testnet';
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const AGENT = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' as Uuid;
const REF: SignerRef = { kind: 'managed_agent', network: NETWORK, scope: TENANT, agentId: AGENT };

describe('agent service logs', () => {
  it('captured logs contain only the allowed fields', async () => {
    const keys = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
    const account = (await keys.address(REF, OPTS)).value;
    const service = harness({
      nowSeconds: 1_900_000_000,
      policy: agentPolicy({
        signers: memoryManagedSignerStore([
          {
            network: NETWORK,
            scope: TENANT,
            agentId: AGENT,
            address: account,
            keyRef: 'agent-key-reference',
            keyTags: TENANT,
          },
        ]),
        mandates: memoryMandateIndex([
          {
            network: NETWORK,
            contract: TEST_CONTRACT,
            executors: [],
            tenant: TENANT,
            recipientMode: 'allowlist',
            ...TEST_SETTLEMENT,
          },
        ]),
        rateLimiter: memoryRateLimiter({ limit: 10, windowSeconds: 60n }),
      }),
    });
    const xdrOf = (functionName: string): string =>
      testInvokeXdr({ source: account, calls: [{ contract: TEST_CONTRACT, functionName }] });
    const call = (functionName: string): SignPayload => ({
      kind: 'stellar_tx',
      network: NETWORK,
      xdr: xdrOf(functionName),
    });
    const signature = await service.remote.sign(REF, call('request_payout'), OPTS);
    expect(await codeOf(service.remote.sign(REF, call('approve'), OPTS))).toBe('SIGNER_DENIED');

    const allowed = new Set<string>([...SIGNER_LOG_FIELDS, 'time', 'level', 'event', 'requestId']);
    for (const record of service.records) {
      expect(Object.keys(record).filter((key) => !allowed.has(key))).toEqual([]);
    }
    expect(service.records.map((r) => r.event)).toEqual(['sign_ok', 'request_refused']);
    expect(service.records[0]).toMatchObject({
      caller: 'payouts',
      refKind: 'managed_agent',
      payloadKind: 'stellar_tx',
      principalId: TENANT.principalId,
      projectId: TENANT.projectId,
    });

    const text = JSON.stringify(service.records);
    for (const secret of [
      account,
      TEST_CONTRACT,
      'agent-key-reference',
      xdrOf('request_payout'),
      CALLER_TOKEN,
      TEST_SEED,
      Buffer.from(signature.signature).toString('base64'),
      Buffer.from(signature.publicKey).toString('hex'),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
