// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { ApiKeyListItem, apiKeysApi } from './api-keys';
import { ApiProblem, createDataClient } from './client';
import { createFakeApi, FAKE_STEP_UP_CODE } from './fake-api';
import { sessionApi } from './session';

const NOW = new Date('2026-11-06T10:00:00.000Z');

function setup(options: { seed?: boolean } = {}) {
  let now = NOW;
  const fake = createFakeApi({ now: () => now, seed: options.seed ?? true });
  const client = createDataClient({ baseUrl: 'https://dashboard.example.test', fetch: fake.fetch });
  return {
    fake,
    keys: apiKeysApi(client),
    session: sessionApi(client),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function problemOf(promise: Promise<unknown>): Promise<ApiProblem> {
  const error = await promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e,
  );
  if (!(error instanceof ApiProblem)) throw error;
  return error;
}

describe('the fake API key endpoints', () => {
  it('lists a project keys newest first, each matching the list schema and none with a secret', async () => {
    const { keys, fake } = setup();
    const page = await keys.list('labelling');
    expect(page.items.length).toBeGreaterThan(3);
    for (const item of page.items) expect(ApiKeyListItem.safeParse(item).success).toBe(true);
    const created = page.items.map((k) => k.createdAt);
    expect(created).toEqual([...created].sort().reverse());
    expect(fake.served.at(-1)?.body).not.toMatch(/"key"/);
  });

  it('keeps every project apart', async () => {
    const { keys } = setup();
    const labelling = await keys.list('labelling');
    const grants = await keys.list('grants');
    expect(grants.items).toEqual([]);
    const projects = new Set(labelling.items.map((k) => k.projectId));
    expect(projects.size).toBe(1);
    const problem = await problemOf(keys.list('nobody'));
    expect(problem.code).toBe('TOKEN_INVALID');
  });

  it('pages through a long list with the cursor it hands out', async () => {
    const { keys, session } = setup({ seed: false });
    await session.stepUp('grants', FAKE_STEP_UP_CODE);
    for (let i = 0; i < 3; i += 1) {
      await keys.create('grants', {
        name: `Key ${String(i)}`,
        preset: 'read_only',
        expiresInDays: 30,
      });
    }
    const first = await keys.list('grants', { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await keys.list('grants', { limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('asks for a fresh second factor before it creates, rotates or revokes', async () => {
    const { keys, session, advance } = setup();
    const create = { name: 'CI runner', preset: 'payouts' as const, expiresInDays: 90 };
    expect((await problemOf(keys.create('labelling', create))).code).toBe('STEP_UP_REQUIRED');
    const [first] = (await keys.list('labelling')).items;
    if (!first) throw new Error('no seeded key');
    expect((await problemOf(keys.rotate('labelling', first.id, 24))).code).toBe('STEP_UP_REQUIRED');
    expect((await problemOf(keys.revoke('labelling', first.id))).code).toBe('STEP_UP_REQUIRED');

    expect((await problemOf(session.stepUp('labelling', '000000'))).code).toBe(
      'STEP_UP_CODE_INVALID',
    );
    await session.stepUp('labelling', FAKE_STEP_UP_CODE);
    await expect(keys.create('labelling', create)).resolves.toBeDefined();

    // Five minutes is as old as a second factor may be.
    advance(301_000);
    expect((await problemOf(keys.create('labelling', create))).code).toBe('STEP_UP_REQUIRED');
  });

  it('creates a key whose whole text appears once, and only its prefix afterwards', async () => {
    const { keys, session, fake } = setup();
    await session.stepUp('labelling', FAKE_STEP_UP_CODE);
    const issued = await keys.create('labelling', {
      name: 'CI runner',
      scopes: ['payouts:read', 'receipts:read'],
      expiresInDays: 90,
    });
    expect(issued.key.startsWith(`${issued.prefix}_`)).toBe(true);
    expect(issued.scopes).toEqual(['payouts:read', 'receipts:read']);
    expect(new Date(issued.expiresAt).getTime() - NOW.getTime()).toBe(90 * 86_400_000);
    const listed = (await keys.list('labelling')).items.find((k) => k.id === issued.id);
    expect(listed).toMatchObject({ name: 'CI runner', prefix: issued.prefix, lastUsedAt: null });
    const after = fake.served.filter((r) => r.method === 'GET');
    for (const response of after) expect(response.body).not.toContain(issued.key);
  });

  it('refuses an expiry outside the limit, scopes with a preset, and a project at its limit', async () => {
    const { keys, session } = setup({ seed: false });
    await session.stepUp('grants', FAKE_STEP_UP_CODE);
    const tooLong = await problemOf(
      keys.create('grants', { name: 'x', preset: 'full', expiresInDays: 731 }),
    );
    expect(tooLong.code).toBe('API_KEY_EXPIRY_INVALID');
    expect(tooLong.fieldErrors).toEqual([{ field: 'expiresInDays', code: 'invalid_value' }]);

    const both = await problemOf(
      keys.create('grants', {
        name: 'x',
        preset: 'full',
        scopes: ['payouts:read'],
        expiresInDays: 30,
      } as never),
    );
    expect(both.code).toBe('INVALID_REQUEST');

    for (let i = 0; i < 20; i += 1) {
      await keys.create('grants', {
        name: `Key ${String(i)}`,
        preset: 'read_only',
        expiresInDays: 30,
      });
    }
    const full = await problemOf(
      keys.create('grants', { name: 'one more', preset: 'read_only', expiresInDays: 30 }),
    );
    expect(full.code).toBe('API_KEY_LIMIT_REACHED');
  });

  it('rotates a key once, keeping the old one only for the overlap', async () => {
    const { keys, session } = setup();
    await session.stepUp('labelling', FAKE_STEP_UP_CODE);
    const listed = (await keys.list('labelling')).items;
    const old = listed.find((k) => k.revokedAt === null && new Date(k.expiresAt) > NOW);
    if (!old) throw new Error('no live seeded key');
    const rotated = await keys.rotate('labelling', old.id, 24);
    expect(rotated).toMatchObject({ name: old.name, scopes: old.scopes, rotatedFromId: old.id });
    expect(rotated.key.startsWith(`${rotated.prefix}_`)).toBe(true);
    expect(rotated.previousKeyExpiresAt).toBe(
      new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
    );
    const again = await problemOf(keys.rotate('labelling', old.id, 24));
    expect(again.code).toBe('API_KEY_NOT_ROTATABLE');
  });

  it('revokes a key, answers a repeat the same way, and does not know other projects keys', async () => {
    const { keys, session } = setup();
    await session.stepUp('labelling', FAKE_STEP_UP_CODE);
    await session.stepUp('bounties', FAKE_STEP_UP_CODE);
    const [target] = (await keys.list('labelling')).items.filter((k) => k.revokedAt === null);
    if (!target) throw new Error('no live seeded key');
    const first = await keys.revoke('labelling', target.id);
    expect(first.revokedAt).toBe(NOW.toISOString());
    await expect(keys.revoke('labelling', target.id)).resolves.toEqual(first);
    const elsewhere = await problemOf(keys.revoke('bounties', target.id));
    expect(elsewhere.code).toBe('NOT_FOUND');
  });

  it('can be told to fail the next matching request, for error states', async () => {
    const { keys, fake } = setup();
    fake.failNext({ method: 'GET', path: '/v1/api-keys' }, 'DB_UNAVAILABLE');
    const problem = await problemOf(keys.list('labelling'));
    expect(problem.status).toBe(503);
    expect(problem.requestId).toMatch(/^req_fake_/);
    await expect(keys.list('labelling')).resolves.toBeDefined();
  });
});
