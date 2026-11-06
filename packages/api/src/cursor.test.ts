// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes, randomUUID } from 'node:crypto';

import { Cursor } from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';

import { cursorCodec } from './cursor.js';
import type { CursorBinding } from './cursor.js';
import { ApiError } from './errors.js';

const TENANT = { principalId: randomUUID(), projectId: randomUUID() };
const BINDING: CursorBinding = {
  tenant: TENANT,
  route: 'listPayouts',
  query: { status: ['queued'], corridor: undefined },
};
const POSITION = { createdAt: '2026-11-01T10:00:00.123456Z', id: randomUUID() };

function refusal(work: () => unknown): string | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
}

describe('a list cursor', () => {
  it('gives back the position it was made with', () => {
    const codec = cursorCodec(randomBytes(32));
    const cursor = codec.encode(BINDING, POSITION);
    expect(Cursor.parse(cursor)).toBe(cursor);
    expect(codec.decode(BINDING, cursor)).toEqual(POSITION);
  });

  it('reads the same query in any key order, and with absent filters left out', () => {
    const codec = cursorCodec(randomBytes(32));
    const cursor = codec.encode(BINDING, POSITION);
    expect(codec.decode({ ...BINDING, query: { status: ['queued'] } }, cursor)).toEqual(POSITION);
  });

  it.each([
    ['another tenant', { ...BINDING, tenant: { ...TENANT, projectId: randomUUID() } }],
    ['another route', { ...BINDING, route: 'listRecipients' }],
    ['other filters', { ...BINDING, query: { status: ['paid'] } }],
    ['the filters in another order', { ...BINDING, query: { status: ['queued', 'paid'] } }],
  ])('is refused for %s', (_name, binding) => {
    const codec = cursorCodec(randomBytes(32));
    const cursor = codec.encode(BINDING, POSITION);
    expect(refusal(() => codec.decode(binding, cursor))).toBe('INVALID_CURSOR');
  });

  it('is refused under another key', () => {
    const cursor = cursorCodec(randomBytes(32)).encode(BINDING, POSITION);
    expect(refusal(() => cursorCodec(randomBytes(32)).decode(BINDING, cursor))).toBe(
      'INVALID_CURSOR',
    );
  });

  it.each(['', 'x', 'A'.repeat(43), '!!!', 'A'.repeat(1025)])('is refused as %j', (text) => {
    const codec = cursorCodec(randomBytes(32));
    expect(refusal(() => codec.decode(BINDING, text))).toBe('INVALID_CURSOR');
  });

  it('is refused when any character changes', () => {
    const codec = cursorCodec(randomBytes(32));
    const cursor = codec.encode(BINDING, POSITION);
    for (let i = 0; i < cursor.length; i += 7) {
      const changed = `${cursor.slice(0, i)}${cursor[i] === 'A' ? 'B' : 'A'}${cursor.slice(i + 1)}`;
      expect(
        refusal(() => codec.decode(BINDING, changed)),
        String(i),
      ).toBe('INVALID_CURSOR');
    }
  });

  it('needs a key long enough to sign with', () => {
    expect(() => cursorCodec(randomBytes(16))).toThrow();
  });
});
