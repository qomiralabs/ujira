// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for what a signer process does before it takes work (boot.ts).
 *
 * bootSignerService(role, options) reads the environment, builds the backend,
 * runs the role's startup verification and only then opens a port. Any failure
 * throws with nothing listening. runSignerService logs that failure with codes
 * and variable names only and exits 1. entry.process.test.ts proves the same
 * against real processes.
 */

import {
  PUBLIC_TEST_ATTESTER_KEYS,
  SignerAddressMismatchError,
  SignerDeniedError,
  SignerUnavailableError,
} from '@ujira/chain-adapter';
import type { NetworkId, SignerRef, Uuid } from '@ujira/chain-adapter';
import { encodeAccountAddress } from '@ujira/chain-adapter/codecs';
import { TEST_DESTINATION } from '@ujira/chain-adapter/testing';
import { describe, expect, it, vi } from 'vitest';

import { ED25519_SPEC } from '../aws-kms/index.js';
import { RemoteSigner } from '../remote.js';
import {
  ADAPTER_TOKEN,
  CALLER_TOKENS,
  ENTRY_SEED,
  IDENTITY_TOKEN,
  NETWORK,
  PAYOUTS_TOKEN,
  networksDocument,
  spkiOf,
} from '../testing/entry.js';
import { bootSignerService, runSignerService } from './boot.js';
import type { BootOptions, SignerRole, SignerStores } from './boot.js';
import { memorySignerLogger } from './log.js';
import {
  memoryAttestationLog,
  memoryManagedSignerStore,
  memoryMandateIndex,
  memoryRateLimiter,
  memorySponsorshipLedger,
} from './memory.js';

const OPTS = { correlationId: 'boot-test' };
const OWN_KEY = 'b7'.repeat(32);
const TENANT = {
  principalId: '6f1c2a5e-0b7d-4c1e-9a3f-2d8b7c6e5a41' as Uuid,
  projectId: '0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f' as Uuid,
};
const OTHER_TENANT = { ...TENANT, projectId: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as Uuid };
const AGENT = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' as Uuid;

async function localEnv(extra: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'staging',
    PORT: '0',
    UJIRA_SIGNER_BACKEND: 'local',
    UJIRA_SIGNER_LOCAL_SEED: ENTRY_SEED,
    UJIRA_NETWORKS_CONFIG: await networksDocument(),
    ...CALLER_TOKENS,
    ...extra,
  };
}

const KMS_ENV = {
  UJIRA_SIGNER_BACKEND: 'aws_kms',
  AWS_ROLE_ARN: 'arn:aws:iam::000000000000:role/signer-test',
  AWS_WEB_IDENTITY_TOKEN_FILE: '/nonexistent/token',
  UJIRA_ATTESTER_KMS_KEY_ID: 'attester-key',
  UJIRA_SIGNER_LOCAL_SEED: undefined,
};

/** A key manager holding one key, under any key id. */
const kmsHolding = (publicKeyHex: string) =>
  vi.fn((command: unknown) => {
    expect((command as object).constructor.name).toBe('GetPublicKeyCommand');
    return Promise.resolve({ KeySpec: ED25519_SPEC, PublicKey: spkiOf(publicKeyHex) });
  });

const neverListens = () => vi.fn<NonNullable<BootOptions['listen']>>();

function boot(role: SignerRole, env: BootOptions['env'], extra: Partial<BootOptions> = {}) {
  return bootSignerService(role, { env, logger: memorySignerLogger(), ...extra });
}

function client(port: number, token: string) {
  return new RemoteSigner({
    baseUrl: `http://127.0.0.1:${String(port)}`,
    token,
    timeoutMs: 20_000,
  });
}

describe('the attester service', () => {
  it.each(PUBLIC_TEST_ATTESTER_KEYS)(
    'never reaches the listen step with the public test key %s outside a test',
    async (key) => {
      const env = await localEnv({ ...KMS_ENV, NODE_ENV: 'production' });
      const listen = neverListens();
      const run = boot('attester', env, { kmsSend: kmsHolding(key), listen });
      await expect(run).rejects.toBeInstanceOf(SignerDeniedError);
      expect(listen).not.toHaveBeenCalled();
    },
  );

  it('listens with a key of its own, in production', async () => {
    const env = await localEnv({ ...KMS_ENV, NODE_ENV: 'production' });
    const running = await boot('attester', env, { kmsSend: kmsHolding(OWN_KEY) });
    try {
      const attester: SignerRef = { kind: 'attester', network: NETWORK };
      const { value } = await client(running.port, IDENTITY_TOKEN).address(attester, OPTS);
      expect(value).toBe(encodeAccountAddress(Uint8Array.from(Buffer.from(OWN_KEY, 'hex'))));
    } finally {
      await running.close();
    }
  });

  it('needs a key id when its keys are in KMS', async () => {
    const env = await localEnv({ ...KMS_ENV, UJIRA_ATTESTER_KMS_KEY_ID: undefined });
    await expect(boot('attester', env)).rejects.toMatchObject({
      issues: ['UJIRA_ATTESTER_KMS_KEY_ID (missing)'],
    });
  });

  it('does not listen when the key manager cannot answer', async () => {
    const env = await localEnv({ ...KMS_ENV, NODE_ENV: 'production' });
    const listen = neverListens();
    const down = () =>
      Promise.reject(Object.assign(new Error('down'), { name: 'KMSInternalException' }));
    await expect(boot('attester', env, { kmsSend: down, listen })).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
    expect(listen).not.toHaveBeenCalled();
  });
});

describe('the chain service', () => {
  it('never reaches the listen step when a pinned address is wrong', async () => {
    const wrongSponsor = TEST_DESTINATION;
    const env = await localEnv({
      UJIRA_NETWORKS_CONFIG: await networksDocument({ wrongSponsor }),
    });
    const listen = neverListens();
    await expect(boot('chain', env, { listen })).rejects.toBeInstanceOf(SignerAddressMismatchError);
    expect(listen).not.toHaveBeenCalled();
  });

  it('never reaches the listen step with a local key pinned in production', async () => {
    const env = await localEnv({ ...KMS_ENV, NODE_ENV: 'production' });
    const listen = neverListens();
    await expect(boot('chain', env, { listen, kmsSend: vi.fn() })).rejects.toBeInstanceOf(
      SignerDeniedError,
    );
    expect(listen).not.toHaveBeenCalled();
  });

  it('checks its pins against KMS and listens when they all match', async () => {
    // A key of its own for each key id, since configuration refuses one
    // account pinned for two jobs.
    const keys: Record<string, string> = { executor_0: OWN_KEY, fee_sponsor: 'c8'.repeat(32) };
    const accountOf = (hex: string) =>
      encodeAccountAddress(Uint8Array.from(Buffer.from(hex, 'hex')));
    const pins = JSON.parse(await networksDocument({ provider: 'aws_kms' })) as Record<
      NetworkId,
      {
        executor: { keys: { keyId: string; address: string }[] };
        feeSponsor: { key: { keyId: string; address: string } };
      }
    >;
    const section = pins[NETWORK];
    for (const pin of [...section.executor.keys, section.feeSponsor.key]) {
      pin.address = accountOf(keys[pin.keyId] ?? '');
    }
    const env = await localEnv({
      ...KMS_ENV,
      NODE_ENV: 'production',
      UJIRA_NETWORKS_CONFIG: JSON.stringify(pins),
    });
    const send = vi.fn((command: unknown) => {
      const { KeyId } = (command as { input: { KeyId: string } }).input;
      return Promise.resolve({
        KeySpec: ED25519_SPEC,
        PublicKey: spkiOf(keys[KeyId] ?? ''),
      });
    });
    const running = await boot('chain', env, { kmsSend: send });
    await running.close();
    expect(send).toHaveBeenCalled();
  });
});

describe('the agent service', () => {
  it('never starts with a local backend in production', async () => {
    const env = await localEnv({ NODE_ENV: 'production' });
    const listen = neverListens();
    await expect(boot('agent', env, { listen })).rejects.toBeInstanceOf(SignerDeniedError);
    expect(listen).not.toHaveBeenCalled();
  });

  it("resolves a managed key from the tenant's own row and nobody else's", async () => {
    const stores: SignerStores = {
      mandates: memoryMandateIndex(),
      sponsorships: memorySponsorshipLedger(),
      rateLimiter: memoryRateLimiter({ limit: 1, windowSeconds: 60n }),
      attestations: memoryAttestationLog(),
      signers: memoryManagedSignerStore([
        {
          network: NETWORK,
          scope: TENANT,
          agentId: AGENT,
          address: TEST_DESTINATION,
          keyRef: 'agent-key',
          keyTags: TENANT,
        },
      ]),
    };
    const env = await localEnv({ ...KMS_ENV, NODE_ENV: 'production' });
    const running = await boot('agent', env, { kmsSend: kmsHolding(OWN_KEY), stores });
    try {
      const payouts = client(running.port, PAYOUTS_TOKEN);
      const ref = (scope: typeof TENANT): SignerRef => ({
        kind: 'managed_agent',
        network: NETWORK,
        scope,
        agentId: AGENT,
      });
      expect((await payouts.address(ref(TENANT), OPTS)).value).toMatch(/^G/);
      await expect(payouts.address(ref(OTHER_TENANT), OPTS)).rejects.toBeInstanceOf(
        SignerDeniedError,
      );
    } finally {
      await running.close();
    }
  });
});

describe.each<[SignerRole, string, string, SignerRef]>([
  ['chain', ADAPTER_TOKEN, IDENTITY_TOKEN, { kind: 'attester', network: NETWORK }],
  ['agent', PAYOUTS_TOKEN, IDENTITY_TOKEN, { kind: 'fee_sponsor', network: NETWORK }],
  ['attester', IDENTITY_TOKEN, PAYOUTS_TOKEN, { kind: 'fee_sponsor', network: NETWORK }],
])('the %s service', (role, own, other, notServed) => {
  it('accepts its own callers and refuses the others', async () => {
    const running = await boot(role, await localEnv());
    try {
      const health = await client(running.port, own).health(OPTS);
      expect(health.state).toBeDefined();
      await expect(client(running.port, other).health(OPTS)).rejects.toBeInstanceOf(
        SignerDeniedError,
      );
    } finally {
      await running.close();
    }
  });

  it('serves its own key kinds and no others', async () => {
    const running = await boot(role, await localEnv());
    try {
      await expect(client(running.port, own).address(notServed, OPTS)).rejects.toBeInstanceOf(
        SignerDeniedError,
      );
    } finally {
      await running.close();
    }
  });
});

describe('reading the environment', () => {
  it.each([
    ['no backend', { UJIRA_SIGNER_BACKEND: undefined }, 'UJIRA_SIGNER_BACKEND (invalid_value)'],
    ['an unknown backend', { UJIRA_SIGNER_BACKEND: 'hsm' }, 'UJIRA_SIGNER_BACKEND (invalid_value)'],
    ['no port', { PORT: undefined }, 'PORT (invalid_type)'],
    ['a port that is no number', { PORT: 'abc' }, 'PORT (invalid_format)'],
    ['a port out of range', { PORT: '70000' }, 'PORT (too_big)'],
    ['no networks', { UJIRA_NETWORKS_CONFIG: undefined }, 'UJIRA_NETWORKS_CONFIG (invalid_type)'],
    [
      'networks that are no JSON',
      { UJIRA_NETWORKS_CONFIG: '{oops' },
      'UJIRA_NETWORKS_CONFIG (invalid_json)',
    ],
    [
      'an empty networks document',
      { UJIRA_NETWORKS_CONFIG: '{}' },
      'UJIRA_NETWORKS_CONFIG (no_networks)',
    ],
    [
      'a missing caller token',
      { UJIRA_SIGNER_TOKEN_PAYOUTS: undefined },
      'UJIRA_SIGNER_TOKEN_PAYOUTS (missing)',
    ],
  ])('refuses %s, naming it', async (_label, change, issue) => {
    const listen = neverListens();
    await expect(boot('chain', await localEnv(change), { listen })).rejects.toMatchObject({
      issues: [issue],
    });
    expect(listen).not.toHaveBeenCalled();
  });

  it('binds to loopback unless told otherwise', async () => {
    const listen = vi.fn<NonNullable<BootOptions['listen']>>(() =>
      Promise.resolve({ port: 1, close: () => Promise.resolve() }),
    );
    await boot('agent', await localEnv(), { listen });
    expect(listen.mock.calls[0]?.[1].hostname).toBe('127.0.0.1');
    await boot('agent', await localEnv({ UJIRA_SIGNER_HOST: '0.0.0.0' }), { listen });
    expect(listen.mock.calls[1]?.[1].hostname).toBe('0.0.0.0');
  });
});

describe('running a service', () => {
  function runner() {
    const lines: string[] = [];
    const exit = vi.fn<(code: number) => void>();
    return { lines, exit, writeLine: (line: string) => lines.push(line) };
  }

  it('logs a startup failure with codes and names only, and exits 1', async () => {
    const r = runner();
    const secret = `oops-${'z'.repeat(40)}`;
    const env = await localEnv({
      UJIRA_NETWORKS_CONFIG: `{${secret}`,
      UJIRA_SIGNER_LOCAL_SEED: secret,
    });
    await runSignerService('chain', { env, exit: r.exit, writeLine: r.writeLine });
    expect(r.exit).toHaveBeenCalledExactlyOnceWith(1);
    const record = JSON.parse(r.lines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({
      event: 'startup_refused',
      level: 'error',
      errorCode: 'INVALID_INPUT',
      issues: ['UJIRA_NETWORKS_CONFIG (invalid_json)'],
    });
    expect(r.lines.join('')).not.toContain(secret);
  });

  it('names the network when a key check refuses', async () => {
    const r = runner();
    const [key = ''] = PUBLIC_TEST_ATTESTER_KEYS;
    const env = await localEnv({ ...KMS_ENV, NODE_ENV: 'production' });
    await runSignerService('attester', {
      env,
      exit: r.exit,
      writeLine: r.writeLine,
      kmsSend: kmsHolding(key),
    });
    expect(r.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(JSON.parse(r.lines.at(-1) ?? '{}')).toMatchObject({
      event: 'startup_refused',
      errorCode: 'SIGNER_DENIED',
      network: NETWORK,
    });
    expect(r.lines.join('')).not.toContain('attester-key');
  });

  it.each([
    [
      'a system error',
      Object.assign(new Error('secret text'), { code: 'EADDRINUSE' }),
      'EADDRINUSE',
    ],
    ['anything else', new Error('secret text'), 'INTERNAL'],
    [
      'a code that is not a system error',
      Object.assign(new Error('x'), { code: 'secret text' }),
      'INTERNAL',
    ],
    ['a port error with no network', new SignerUnavailableError(), 'SIGNER_UNAVAILABLE'],
  ])('reports %s by its code alone', async (_label, failure, code) => {
    const r = runner();
    await runSignerService('agent', {
      env: await localEnv(),
      exit: r.exit,
      writeLine: r.writeLine,
      listen: () => Promise.reject(failure),
    });
    expect(r.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(JSON.parse(r.lines.at(-1) ?? '{}')).toMatchObject({ errorCode: code });
    expect(r.lines.join('')).not.toContain('secret text');
  });

  it('exits 0 when asked to stop, and 1 if it cannot close', async () => {
    for (const [close, code] of [
      [() => Promise.resolve(), 0],
      [() => Promise.reject(new Error('stuck')), 1],
    ] as const) {
      const r = runner();
      let stop = (): void => undefined;
      await runSignerService('agent', {
        env: await localEnv(),
        exit: r.exit,
        writeLine: r.writeLine,
        listen: () => Promise.resolve({ port: 1, close }),
        onStopRequest: (handler) => {
          stop = handler;
        },
      });
      expect(r.exit).not.toHaveBeenCalled();
      stop();
      await vi.waitFor(() => {
        expect(r.exit).toHaveBeenCalledExactlyOnceWith(code);
      });
    }
  });
});
