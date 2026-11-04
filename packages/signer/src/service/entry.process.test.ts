// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The entry points as real processes, started the way a platform starts them.
 *
 * The attester's key comes through the real AWS SDK with its real credential
 * chain, pointed at a stand in for STS and KMS on this machine, so a production
 * environment can be proved without an account or a key: a public test key
 * stops the process with a non-zero exit and no port open.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PUBLIC_TEST_ATTESTER_KEYS } from '@ujira/chain-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ED25519_SPEC } from '../aws-kms/index.js';
import {
  CALLER_TOKENS,
  ENTRY_SEED,
  IDENTITY_TOKEN,
  PAYOUTS_TOKEN,
  networksDocument,
  spkiOf,
} from '../testing/entry.js';

// A process imports the whole backend, which is slow on a loaded machine, and
// the repository run ignores this package's own timeout.
const PROCESS_TEST = { timeout: 180_000 };

const PACKAGE = path.resolve(import.meta.dirname, '../..');
const TSC = path.resolve(PACKAGE, '../../node_modules/typescript/bin/tsc');
const OWN_KEY = 'b7'.repeat(32);

type Role = 'chain' | 'agent' | 'attester';

interface Started {
  /** Resolves with the exit code. */
  readonly exited: Promise<number | null>;
  readonly output: () => string;
  readonly listening: Promise<void>;
  readonly stop: () => void;
}

/** Only what is listed reaches the child, so this machine's own settings cannot help it. */
function start(role: Role, env: Record<string, string>): Started {
  const child = spawn(process.execPath, [path.join(home, 'built', `service/main/${role}.js`)], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let announce = (): void => undefined;
  const listening = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const read = (chunk: Buffer): void => {
    output += chunk.toString();
    if (output.includes('"event":"listening"')) announce();
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  return {
    exited: new Promise((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    }),
    output: () => output,
    listening,
    stop: () => {
      child.kill('SIGTERM');
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function isOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

function health(port: number, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/v1/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Stands in for the two AWS services and answers GetPublicKey with one key. */
class AwsStandIn {
  publicKey = OWN_KEY;
  readonly operations: string[] = [];
  #server: Server | undefined;
  port = 0;

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      const target = request.headers['x-amz-target'];
      request.resume();
      request.once('end', () => {
        if (typeof target === 'string') {
          this.operations.push(target);
          response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
          response.end(
            JSON.stringify({
              KeyId: 'attester-key',
              KeySpec: ED25519_SPEC,
              KeyUsage: 'SIGN_VERIFY',
              PublicKey: Buffer.from(spkiOf(this.publicKey)).toString('base64'),
            }),
          );
          return;
        }
        this.operations.push('AssumeRoleWithWebIdentity');
        response.writeHead(200, { 'content-type': 'text/xml' });
        response.end(
          '<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">' +
            '<AssumeRoleWithWebIdentityResult><Credentials>' +
            '<AccessKeyId>stand-in-id</AccessKeyId><SecretAccessKey>stand-in</SecretAccessKey>' +
            '<SessionToken>stand-in</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration>' +
            '</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>',
        );
      });
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, '127.0.0.1', resolve);
    });
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => {
      this.#server?.close(resolve);
      this.#server?.closeAllConnections();
    });
  }
}

let aws: AwsStandIn;
let home: string;
let networks: string;

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'signer-entry-'));
  // The entry points as tsc emits them, the same as what ships. CI mounts the
  // repository read-only under test, so the build goes in a temporary folder,
  // and the link lets it find its dependencies from there.
  symlinkSync(path.join(PACKAGE, 'node_modules'), path.join(home, 'node_modules'));
  const build = spawnSync(
    process.execPath,
    [TSC, '-p', 'tsconfig.build.json', '--outDir', path.join(home, 'built'), '--noEmitOnError'],
    { cwd: PACKAGE, encoding: 'utf8' },
  );
  expect(build.status, build.stdout).toBe(0);
  aws = new AwsStandIn();
  await aws.start();
  writeFileSync(path.join(home, 'token'), 'stand-in-web-identity-token');
  networks = await networksDocument();
}, 300_000);

afterAll(async () => {
  await aws.stop();
  rmSync(home, { recursive: true, force: true });
});

function kmsEnv(nodeEnv: string, port: number): Record<string, string> {
  const endpoint = `http://127.0.0.1:${String(aws.port)}`;
  return {
    NODE_ENV: nodeEnv,
    PORT: String(port),
    // An empty home, so the SDK finds no credentials or profile of this machine's.
    HOME: home,
    AWS_REGION: 'eu-central-1',
    AWS_ROLE_ARN: 'arn:aws:iam::000000000000:role/signer-attester-test',
    AWS_WEB_IDENTITY_TOKEN_FILE: path.join(home, 'token'),
    AWS_ENDPOINT_URL_STS: endpoint,
    AWS_ENDPOINT_URL_KMS: endpoint,
    UJIRA_SIGNER_BACKEND: 'aws_kms',
    UJIRA_ATTESTER_KMS_KEY_ID: 'attester-key',
    UJIRA_NETWORKS_CONFIG: networks,
    ...CALLER_TOKENS,
  };
}

function localEnv(nodeEnv: string, port: number): Record<string, string> {
  return {
    NODE_ENV: nodeEnv,
    PORT: String(port),
    UJIRA_SIGNER_BACKEND: 'local',
    UJIRA_SIGNER_LOCAL_SEED: ENTRY_SEED,
    UJIRA_NETWORKS_CONFIG: networks,
    ...CALLER_TOKENS,
  };
}

describe('the attester process', () => {
  it.each([
    [PUBLIC_TEST_ATTESTER_KEYS[0] ?? '', 'production'],
    [PUBLIC_TEST_ATTESTER_KEYS[1] ?? '', 'production'],
    [PUBLIC_TEST_ATTESTER_KEYS[0] ?? '', 'staging'],
  ])('refuses to start with the public test key %s in %s', PROCESS_TEST, async (key, nodeEnv) => {
    aws.publicKey = key;
    aws.operations.length = 0;
    const port = await freePort();
    const process = start('attester', kmsEnv(nodeEnv, port));
    expect(await process.exited, process.output()).toBe(1);
    expect(process.output()).toContain('"event":"startup_refused"');
    expect(process.output()).toContain('"errorCode":"SIGNER_DENIED"');
    expect(process.output()).not.toContain('"event":"listening"');
    expect(await isOpen(port)).toBe(false);
    // It really asked the key manager, and it never asked for a signature.
    expect(aws.operations).toContain('TrentService.GetPublicKey');
    expect(aws.operations).not.toContain('TrentService.Sign');
  });

  it(
    'starts in production with a key of its own, answers health and stops cleanly',
    PROCESS_TEST,
    async () => {
      aws.publicKey = OWN_KEY;
      const port = await freePort();
      const process = start('attester', kmsEnv('production', port));
      await Promise.race([process.listening, process.exited]);
      try {
        expect((await health(port, IDENTITY_TOKEN)).status, process.output()).toBe(200);
        expect((await health(port, PAYOUTS_TOKEN)).status).toBe(401);
      } finally {
        process.stop();
      }
      expect(await process.exited, process.output()).toBe(0);
      expect(await isOpen(port)).toBe(false);
    },
  );
});

describe.each<[Role, string]>([
  ['chain', PAYOUTS_TOKEN],
  ['agent', PAYOUTS_TOKEN],
])('the %s process', (role, token) => {
  it('starts, answers health and stops cleanly', PROCESS_TEST, async () => {
    const port = await freePort();
    const process = start(role, localEnv('staging', port));
    await Promise.race([process.listening, process.exited]);
    try {
      expect((await health(port, token)).status, process.output()).toBe(200);
      expect((await health(port, IDENTITY_TOKEN)).status).toBe(401);
    } finally {
      process.stop();
    }
    expect(await process.exited, process.output()).toBe(0);
  });

  it('refuses to start with a local backend in production', PROCESS_TEST, async () => {
    const port = await freePort();
    const process = start(role, localEnv('production', port));
    expect(await process.exited, process.output()).toBe(1);
    expect(process.output()).toContain('"errorCode":"SIGNER_DENIED"');
    expect(await isOpen(port)).toBe(false);
  });
});

describe('a process that cannot start', () => {
  it('names the variable and never prints a token', PROCESS_TEST, async () => {
    const port = await freePort();
    const env = Object.fromEntries(
      Object.entries(localEnv('staging', port)).filter(
        ([name]) => name !== 'UJIRA_SIGNER_TOKEN_PAYOUTS',
      ),
    );
    const process = start('chain', env);
    expect(await process.exited, process.output()).toBe(1);
    expect(process.output()).toContain('UJIRA_SIGNER_TOKEN_PAYOUTS (missing)');
    for (const token of Object.values(CALLER_TOKENS)) {
      expect(process.output()).not.toContain(token);
    }
    expect(process.output()).not.toContain(ENTRY_SEED);
  });
});
