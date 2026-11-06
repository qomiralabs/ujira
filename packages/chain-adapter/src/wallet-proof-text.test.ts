// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain-neutral wallet proof challenge (wallet-proof.ts).
 *
 * walletProofChallenge(req, publicConfig, deps) builds the exact text a
 * wallet signs: the widget host, the address, a purpose line, the URI,
 * version 1, the CAIP-2 network, a 128-bit base32 nonce, issued at,
 * expiration, the request ID, and the resources urn:ujira:recipient:<ref>
 * and urn:ujira:tag:<tag or none>. The host comes only from the public
 * config's widgetHost. The request is strict, so a field that could carry a
 * host is refused rather than ignored. Bad input throws InvalidInputError
 * naming paths and codes only.
 */

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from './errors.js';
import {
  DEFAULT_WALLET_PROOF_TTL_SECONDS,
  base32,
  challengeSeconds,
  parsePublicConfig,
  walletProofChallenge,
  walletProofNonce,
} from './wallet-proof.js';
import type { WalletProofChallengeRequest } from './wallet-proof.js';

const NOW = 1_793_520_000n; // 2026-11-01T08:00:00Z
const NONCE = 'MZXW6YTBOJUWU23MNU3DQOJQGE';
const deps = { nowSeconds: () => NOW, nonce: () => NONCE };
const production = parsePublicConfig({ widgetHost: 'app.ujira.co' });
const sandbox = parsePublicConfig({ widgetHost: 'app.sandbox.ujira.co' });
const ADDRESS = 'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L';

function request(overrides: Partial<Record<string, unknown>> = {}): WalletProofChallengeRequest {
  return {
    network: 'stellar:pubnet',
    address: ADDRESS,
    purpose: 'payout_destination',
    recipientRef: `0x${'ab'.repeat(32)}`,
    tag: 4402118n,
    requestId: '6f1c2e3d-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
    ...overrides,
  };
}

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof InvalidInputError) return error.issues;
    throw error;
  }
  throw new Error('expected InvalidInputError');
}

describe('walletProofChallenge', () => {
  it('lays the text out exactly', () => {
    const challenge = walletProofChallenge(request(), production, deps);
    expect(challenge.text).toBe(
      [
        'app.ujira.co wants you to prove you control this address:',
        ADDRESS,
        '',
        'Confirm that UJIRA may send your payouts to this address.',
        '',
        'URI: https://app.ujira.co',
        'Version: 1',
        'Chain ID: stellar:pubnet',
        `Nonce: ${NONCE}`,
        'Issued At: 2026-11-01T08:00:00Z',
        'Expiration Time: 2026-11-01T08:05:00Z',
        'Request ID: 6f1c2e3d-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
        'Resources:',
        `- urn:ujira:recipient:0x${'ab'.repeat(32)}`,
        '- urn:ujira:tag:4402118',
      ].join('\n'),
    );
    expect(challenge).toMatchObject({
      network: 'stellar:pubnet',
      address: ADDRESS,
      nonce: NONCE,
      issuedAt: '2026-11-01T08:00:00Z',
      expiresAt: '2026-11-01T08:05:00Z',
    });
    expect(challengeSeconds(challenge.expiresAt)).toBe(
      NOW + BigInt(DEFAULT_WALLET_PROOF_TTL_SECONDS),
    );
    expect(Object.isFrozen(challenge)).toBe(true);
  });

  it('widget host is taken from public.widgetHost and a forged Host header has no effect', () => {
    expect(walletProofChallenge(request(), sandbox, deps).text).toMatch(
      /^app\.sandbox\.ujira\.co wants you.*\nURI: https:\/\/app\.sandbox\.ujira\.co\n/s,
    );
    for (const forged of [
      { host: 'evil.example' },
      { headers: { host: 'evil.example' } },
      { widgetHost: 'evil.example' },
      { uri: 'https://evil.example' },
    ]) {
      expect(issuesOf(() => walletProofChallenge(request(forged), production, deps))).toEqual([
        'walletProof (unrecognized_keys)',
      ]);
    }
    // A config that is not a plain host name is refused before any text exists.
    for (const widgetHost of ['evil.example/path', 'https://app.ujira.co', 'App.ujira.co', 'x']) {
      expect(issuesOf(() => parsePublicConfig({ widgetHost }))[0]).toMatch(/^public\.widgetHost/);
    }
    expect(issuesOf(() => parsePublicConfig({ widgetHost: 'a.b', extra: 1 }))).toEqual([
      'public (unrecognized_keys)',
    ]);
  });

  it('states each purpose in its own words', () => {
    const lines = (['payout_destination', 'member_wallet', 'agent_link'] as const).map(
      (purpose) => walletProofChallenge(request({ purpose }), production, deps).text.split('\n')[3],
    );
    expect(new Set(lines).size).toBe(3);
    expect(
      issuesOf(() => walletProofChallenge(request({ purpose: 'login' }), production, deps)),
    ).toEqual(['walletProof.purpose (invalid_value)']);
  });

  it('binds the recipient and the tag, with none for no tag', () => {
    const text = walletProofChallenge(request({ tag: null }), production, deps).text;
    expect(text.endsWith('- urn:ujira:tag:none')).toBe(true);
    const zero = walletProofChallenge(request({ tag: 0n }), production, deps).text;
    expect(zero.endsWith('- urn:ujira:tag:0')).toBe(true);
  });

  it('refuses anything that could break a line or the bindings', () => {
    const cases: [Partial<Record<string, unknown>>, string][] = [
      [
        { address: `${ADDRESS}\nURI: https://evil.example` },
        'walletProof.address (invalid_format)',
      ],
      [{ address: '' }, 'walletProof.address (invalid_format)'],
      [{ network: 'eip155:1' }, 'walletProof.network (custom)'],
      [{ recipientRef: 'ab'.repeat(32) }, 'walletProof.recipientRef (invalid_format)'],
      [{ tag: -1n }, 'walletProof.tag (too_small)'],
      [{ tag: 2n ** 64n }, 'walletProof.tag (too_big)'],
      [{ requestId: 'not-a-uuid' }, 'walletProof.requestId (invalid_format)'],
      [{ ttlSeconds: 29 }, 'walletProof.ttlSeconds (too_small)'],
      [{ ttlSeconds: 901 }, 'walletProof.ttlSeconds (too_big)'],
    ];
    for (const [override, issue] of cases) {
      expect(issuesOf(() => walletProofChallenge(request(override), production, deps))).toEqual([
        issue,
      ]);
    }
    expect(
      issuesOf(() =>
        walletProofChallenge(request(), production, { ...deps, nonce: () => 'short' }),
      ),
    ).toEqual(['walletProof.nonce (invalid)']);
  });

  it('honours a shorter window', () => {
    const challenge = walletProofChallenge(request({ ttlSeconds: 60 }), production, deps);
    expect(challenge.expiresAt).toBe('2026-11-01T08:01:00Z');
  });
});

describe('nonces', () => {
  it('are 128 random bits in 26 base32 characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const nonce = walletProofNonce();
      expect(nonce).toMatch(/^[A-Z2-7]{26}$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(64);
    const challenge = walletProofChallenge(request(), production, { nowSeconds: () => NOW });
    expect(challenge.nonce).toMatch(/^[A-Z2-7]{26}$/);
  });

  it('use RFC 4648 base32', () => {
    const text = (s: string) => base32(new TextEncoder().encode(s));
    expect(text('')).toBe('');
    expect(text('f')).toBe('MY');
    expect(text('fo')).toBe('MZXQ');
    expect(text('foo')).toBe('MZXW6');
    expect(text('foob')).toBe('MZXW6YQ');
    expect(text('fooba')).toBe('MZXW6YTB');
    expect(text('foobar')).toBe('MZXW6YTBOI');
  });
});
