// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashSecret, issueToken, parseToken } from './token.js';

describe('the key format', () => {
  it.each(['live', 'test'] as const)('issues a %s key in the documented shape', (environment) => {
    const { token, prefix, secretSha256 } = issueToken(environment);
    expect(token).toMatch(new RegExp(`^ujk_${environment}_[a-z2-7]{16}_[a-z2-7]{59}$`));
    expect(prefix).toBe(token.slice(0, `ujk_${environment}_`.length + 16));
    // The prefix fits the column's format.
    expect(prefix).toMatch(/^[A-Za-z0-9_]{8,40}$/);
    expect(secretSha256).toHaveLength(32);
  });

  it('holds 256 bits of secret and 80 of id, freshly random each time', () => {
    const issued = Array.from({ length: 50 }, () => issueToken('test'));
    expect(new Set(issued.map((key) => key.prefix)).size).toBe(50);
    expect(new Set(issued.map((key) => key.token)).size).toBe(50);
  });

  it('parses what it issues, and stores only the hash of the secret', () => {
    const { token, prefix, secretSha256 } = issueToken('live');
    const parsed = parseToken(token);
    expect(parsed).toMatchObject({ environment: 'live', prefix });
    const secret = parsed?.secret ?? '';
    expect(secret).toHaveLength(52);
    expect(hashSecret(secret)).toEqual(secretSha256);
    expect(hashSecret(secret)).toEqual(createHash('sha256').update(secret).digest());
    expect(secretSha256.toString('utf8')).not.toContain(secret);
  });

  it('refuses every single character change, so a typo never reaches the database', () => {
    const { token } = issueToken('test');
    const bodyStart = 'ujk_test_'.length;
    for (let at = bodyStart; at < token.length; at += 1) {
      if (token[at] === '_') continue;
      const swapped = token[at] === 'a' ? 'b' : 'a';
      expect(parseToken(`${token.slice(0, at)}${swapped}${token.slice(at + 1)}`), String(at)).toBe(
        null,
      );
    }
  });

  it.each([
    ['empty', ''],
    ['another scheme', 'sk_live_abc'],
    ['upper case', issueToken('test').token.toUpperCase()],
    ['an unknown environment', issueToken('test').token.replace('_test_', '_prod_')],
    ['too short', issueToken('test').token.slice(0, -1)],
    ['too long', `${issueToken('test').token}a`],
    ['surrounding space', ` ${issueToken('test').token}`],
    ['a digit base32 does not use', issueToken('test').token.replace(/_[a-z2-7]/, '_1')],
  ])('refuses %s', (_name, text) => {
    expect(parseToken(text)).toBeNull();
  });
});
