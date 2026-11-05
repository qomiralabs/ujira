// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { McpConfigError, loadMcpConfig } from './config.js';
import { API_KEY } from './fake-api.test-support.js';

const URL_OK = 'https://api.ujira.test';

function messageOf(env: Record<string, string | undefined>): string {
  try {
    loadMcpConfig(env);
  } catch (error) {
    if (error instanceof McpConfigError) return error.message;
    throw error;
  }
  throw new Error('it was accepted');
}

describe('the key', () => {
  it('takes an API key', () => {
    expect(loadMcpConfig({ UJIRA_API_KEY: API_KEY, UJIRA_API_URL: URL_OK })).toEqual({
      apiKey: API_KEY,
      apiUrl: URL_OK,
    });
  });

  it('a Stellar secret seed in the key variable is refused, and not printed', () => {
    // A seed's form, built here so no file holds one.
    const seed = `S${'A'.repeat(55)}`;
    const message = messageOf({ UJIRA_API_KEY: seed, UJIRA_API_URL: URL_OK });
    expect(message).toContain('never a wallet secret');
    expect(message).not.toContain(seed);
  });

  it.each([
    ['a hex private key', '0x' + 'f'.repeat(64)],
    ['a phrase', 'one two three four five six seven eight nine ten eleven twelve'],
    ['a key with a character changed', API_KEY.replace('ujk_test', 'ujk_prod')],
    ['a key cut short', API_KEY.slice(0, -1)],
  ])('refuses %s, and does not print it', (_name, value) => {
    const message = messageOf({ UJIRA_API_KEY: value, UJIRA_API_URL: URL_OK });
    expect(message).not.toContain(value);
  });

  it.each([[undefined], ['']])('says so when it is not set: %s', (value) => {
    expect(messageOf({ UJIRA_API_KEY: value, UJIRA_API_URL: URL_OK })).toBe(
      'UJIRA_API_KEY is not set',
    );
  });
});

describe('the URL', () => {
  const withUrl = (url: string | undefined) =>
    messageOf({ UJIRA_API_KEY: API_KEY, UJIRA_API_URL: url });

  it('refuses http except on the local machine', () => {
    expect(withUrl('http://api.ujira.test')).toContain('must use https');
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(loadMcpConfig({ UJIRA_API_KEY: API_KEY, UJIRA_API_URL: url }).apiUrl).toBe(url);
    }
  });

  it('is not fooled by a local name in another part of the URL', () => {
    expect(withUrl('http://localhost.evil.test')).toContain('must use https');
    expect(withUrl('http://localhost@evil.test')).toContain('must use https');
  });

  it.each([
    ['another scheme', 'ftp://api.ujira.test', 'must use https'],
    ['credentials', 'https://user:pass@api.ujira.test', 'no credentials'],
    ['a query', 'https://api.ujira.test/?a=b', 'no credentials'],
    ['a fragment', 'https://api.ujira.test/#a', 'no credentials'],
    ['a path', 'https://api.ujira.test/v1', 'with no path'],
    ['nonsense', 'not a url', 'not a valid URL'],
  ])('refuses %s', (_name, url, expected) => {
    expect(withUrl(url)).toContain(expected);
  });

  it.each([[undefined], ['']])('says so when it is not set: %s', (value) => {
    expect(withUrl(value)).toBe('UJIRA_API_URL is not set');
  });
});
