// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Proves that the release age settings in pnpm-workspace.yaml make a frozen
// install fail on a lockfile entry that is too new. The repository's own
// minimumReleaseAge settings are copied into a fixture project whose single
// dependency is served by a registry stub on 127.0.0.1, so the real pnpm runs
// the same check CI runs, without touching the network. Other workspace
// settings, such as overrides, are left out: they would not match the
// fixture lockfile.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvePnpmCommand } from './pnpm-command.ts';

const ROOT = join(import.meta.dirname, '..');
const WORKSPACE = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');

// The top level minimumReleaseAge* keys of a workspace file, each with the
// indented lines and comments under it, in file order.
function releaseAgeSettings(yaml: string): string {
  const kept: string[] = [];
  let keep = false;
  for (const line of yaml.split('\n')) {
    if (/^[A-Za-z]/.test(line)) keep = line.startsWith('minimumReleaseAge');
    if (keep && !line.startsWith('#')) kept.push(line);
  }
  return `${kept.join('\n').trimEnd()}\n`;
}

const SETTINGS = releaseAgeSettings(WORKSPACE);
const NAME = 'release-age-fixture';
const VERSION = '1.0.0';
const DAY = 24 * 60 * 60 * 1000;

// A one file npm tarball: package/package.json in a ustar archive.
function tarball(): Buffer {
  const body = Buffer.from(JSON.stringify({ name: NAME, version: VERSION }));
  const header = Buffer.alloc(512);
  const field = (offset: number, value: string) => header.write(value, offset, 'latin1');
  field(0, 'package/package.json');
  field(100, '0000644\0');
  field(108, '0000000\0');
  field(116, '0000000\0');
  field(124, `${body.length.toString(8).padStart(11, '0')}\0`);
  field(136, '00000000000\0');
  field(148, '        ');
  field(156, '0');
  field(257, 'ustar\0');
  field(263, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

const TARBALL = tarball();
const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;

// Publish time served for the fixture version; undefined leaves it out.
let published: string | undefined;
let server: Server;
let registry: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === `/${NAME}`) {
      const time = published === undefined ? {} : { created: published, [VERSION]: published };
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name: NAME,
          'dist-tags': { latest: VERSION },
          versions: {
            [VERSION]: {
              name: NAME,
              version: VERSION,
              dist: {
                tarball: `${registry}${NAME}/-/${NAME}-${VERSION}.tgz`,
                integrity: INTEGRITY,
              },
            },
          },
          time,
        }),
      );
    } else if (request.url === `/${NAME}/-/${NAME}-${VERSION}.tgz`) {
      response.end(TARBALL);
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

function lockfile(): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      ${NAME}:`,
    `        specifier: ${VERSION}`,
    `        version: ${VERSION}`,
    '',
    'packages:',
    '',
    `  ${NAME}@${VERSION}:`,
    `    resolution: {integrity: ${INTEGRITY}}`,
    '',
    'snapshots:',
    '',
    `  ${NAME}@${VERSION}: {}`,
    '',
  ].join('\n');
}

interface Result {
  code: number | null;
  output: string;
}

// Runs `pnpm install --frozen-lockfile` in a fresh fixture project with the
// repository's workspace settings, plus `extra` appended to them.
async function frozenInstall(extra = ''): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), 'release-age-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.0.0',
        private: true,
        dependencies: { [NAME]: VERSION },
      }),
    );
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), `packages: []\n${SETTINGS}${extra}`);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lockfile());
    const command = resolvePnpmCommand(
      process.env['npm_execpath'],
      process.execPath,
      ROOT,
      [
        'install',
        '--frozen-lockfile',
        `--registry=${registry}`,
        `--config.cache-dir=${join(dir, '.cache')}`,
        `--config.store-dir=${join(dir, '.store')}`,
        '--config.update-notifier=false',
      ],
      {
        realpath: (path) => {
          try {
            return realpathSync(path);
          } catch {
            return undefined;
          }
        },
        packageName: (folder) => {
          try {
            const parsed = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as {
              name?: unknown;
            };
            return typeof parsed.name === 'string' ? parsed.name : undefined;
          } catch {
            return undefined;
          }
        },
      },
    );
    // A private config folder, so no user or global pnpm settings apply.
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, '.config'), CI: 'true' };
    return await new Promise<Result>((resolve, reject) => {
      const child = spawn(command.file, command.args, { cwd: dir, env });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, output });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

describe('minimum release age', { timeout: 60_000 }, () => {
  it('fails a frozen install on a version published 13 days ago', async () => {
    published = daysAgo(13);
    const result = await frozenInstall();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION');
    expect(result.output).toContain(`${NAME}@${VERSION}`);
  });

  it('passes a frozen install on a version published 15 days ago', async () => {
    published = daysAgo(15);
    const result = await frozenInstall();
    expect(result.output).not.toContain('ERR_PNPM');
    expect(result.code).toBe(0);
  });

  it('fails a frozen install when the registry cannot date the version', async () => {
    published = undefined;
    const result = await frozenInstall();
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/ERR_PNPM_(MISSING_TIME|MINIMUM_RELEASE_AGE_VIOLATION)/);
  });

  it('lets an exact version exclude through', async () => {
    published = daysAgo(1);
    const result = await frozenInstall(`  - '${NAME}@${VERSION}'\n`);
    expect(result.output).not.toContain('ERR_PNPM');
    expect(result.code).toBe(0);
  });

  it('copies every release age setting, with the exclude list last', () => {
    expect(SETTINGS).toMatch(/^minimumReleaseAge: 20160$/m);
    expect(SETTINGS).toMatch(/^minimumReleaseAgeIgnoreMissingTime: false$/m);
    expect(SETTINGS).toMatch(/^minimumReleaseAgeExcludePrune: true$/m);
    expect(SETTINGS).not.toMatch(/^(overrides|allowBuilds|packages):/m);
    const keys = [...SETTINGS.matchAll(/^([A-Za-z]\w*):/gm)].map((m) => m[1]);
    expect(keys.at(-1)).toBe('minimumReleaseAgeExclude');
  });

  it('keeps the exclude list to exact versions', () => {
    const block = /^minimumReleaseAgeExclude:\n((?:[ \t]+(?:#.*|-.*)\n)+)/m.exec(WORKSPACE)?.[1];
    expect(block).toBeDefined();
    const entries = [...(block ?? '').matchAll(/^\s+-\s+'([^']+)'\s*$/gm)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries)
      expect(entry).toMatch(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d[\w.+-]*$/);
  });
});
