// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for Stellar wallet proofs (sep53.ts and wallet-proof.ts).
 *
 * A proof is the issued challenge text signed per SEP-53: ed25519 over
 * SHA-256("Stellar Signed Message:\n" + message). verifyStellarWalletProof
 * accepts a G, or the G behind an M; a C cannot sign and is
 * UNSUPPORTED_ACCOUNT. Checks run in order and the first failure is the
 * reason: MESSAGE_MISMATCH when the signed text is not exactly the issued
 * text (so a changed tag or recipient fails here), EXPIRED at or after the
 * expiration time, WRONG_SIGNER when the reported signer is not an account
 * key, BAD_SIGNATURE when the signature does not verify under it,
 * ACCOUNT_NOT_FOUND when the ledger has no account, and
 * SIGNER_NOT_AUTHORIZED when the key may not sign for the account today.
 */

import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  STRKEY_VERSION,
  decodeAccountAddress,
  encodeAccountAddress,
  encodeMuxedAddress,
  encodeStrkey,
} from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import { parsePublicConfig, walletProofChallenge } from '../wallet-proof.js';
import type { WalletProofChallenge } from '../wallet-proof.js';
import type { StellarAccountEntry } from './account-rules.js';
import { SEP53_PREFIX, sep53Hash, verifySep53 } from './sep53.js';
import { verifyStellarWalletProof } from './wallet-proof.js';

// The test vectors published with SEP-53. Only the public address and the
// signatures are used, so no secret seed sits in the source.
const VECTOR_ADDRESS = 'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L';
const VECTORS: [string, string | Uint8Array, string][] = [
  [
    'ASCII',
    'Hello, World!',
    'fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==',
  ],
  [
    'Japanese',
    'こんにちは、世界！',
    'CDU265Xs8y3OWbB/56H9jPgUss5G9A0qFuTqH2zs2YDgTm+++dIfmAEceFqB7bhfN3am59lCtDXrCtwH2k1GBA==',
  ],
  [
    'binary',
    Buffer.from('2zZDP1sa1BVBfLP7TeeMk3sUbaxAkUhBhDiNdrksaFo=', 'base64'),
    'VA1+7hefNwv2NKScH6n+Sljj15kLAge+M2wE7fzFOf+L0MMbssA1mwfJZRyyrhBORQRle10X1Dxpx+UOI4EbDQ==',
  ],
];

interface TestKey {
  readonly address: string;
  readonly publicKey: Uint8Array;
  signText(text: string): string;
}

// A throwaway key per test run.
function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url'));
  return {
    address: encodeAccountAddress(raw),
    publicKey: raw,
    signText: (text) => sign(null, sep53Hash(text), privateKey).toString('base64'),
  };
}

const NETWORK = 'stellar:testnet';
const NOW = 1_793_520_000n;
const config = parsePublicConfig({ widgetHost: 'app.ujira.co' });

function challengeFor(address: string, tag: bigint | null = null): WalletProofChallenge {
  return walletProofChallenge(
    {
      network: NETWORK,
      address,
      purpose: 'payout_destination',
      recipientRef: `0x${'cd'.repeat(32)}`,
      tag,
      requestId: '0d4f6a2b-8c1e-4d3f-9a5b-7c6e1f2a3b4c',
    },
    config,
    { nowSeconds: () => NOW },
  );
}

function account(id: string, overrides: Partial<StellarAccountEntry> = {}): StellarAccountEntry {
  return {
    accountId: id,
    masterWeight: 1,
    thresholds: { low: 0, medium: 0, high: 0 },
    signers: [],
    ...overrides,
  };
}

describe('SEP-53', () => {
  it.each(VECTORS)('verifies the published %s vector', (_label, message, signature) => {
    const key = decodeAccountAddress(VECTOR_ADDRESS);
    expect(verifySep53(key, message, Buffer.from(signature, 'base64'))).toBe(true);
    expect(verifySep53(key, `${String(message)}!`, Buffer.from(signature, 'base64'))).toBe(false);
  });

  it('hashes the prefix and the message bytes', () => {
    expect(SEP53_PREFIX).toBe('Stellar Signed Message:\n');
    expect(sep53Hash('a')).toEqual(sep53Hash(new TextEncoder().encode('a')));
    expect(sep53Hash('a')).toHaveLength(32);
  });

  it('refuses keys and signatures of the wrong length', () => {
    const key = decodeAccountAddress(VECTOR_ADDRESS);
    expect(verifySep53(key.slice(1), 'x', new Uint8Array(64))).toBe(false);
    expect(verifySep53(key, 'x', new Uint8Array(63))).toBe(false);
  });
});

describe('verifyStellarWalletProof', () => {
  const key = testKey();

  function proof(challenge: WalletProofChallenge, signed = challenge.text, signer = key) {
    return { challenge, signedText: signed, signature: signer.signText(signed) };
  }

  it('accepts the challenge signed by the account key', () => {
    const challenge = challengeFor(key.address);
    expect(
      verifyStellarWalletProof(NETWORK, proof(challenge), { account: account(key.address) }, NOW),
    ).toEqual({ status: 'valid', scheme: 'sep53', signer: key.address });
  });

  it('accepts an M address through the G behind it', () => {
    const muxed = encodeMuxedAddress(key.publicKey, 77n);
    const challenge = challengeFor(muxed, 77n);
    expect(challenge.text).toContain(muxed);
    expect(
      verifyStellarWalletProof(NETWORK, proof(challenge), { account: account(key.address) }, NOW)
        .status,
    ).toBe('valid');
  });

  it('refuses an expired challenge', () => {
    const challenge = challengeFor(key.address);
    const ledger = { account: account(key.address) };
    expect(verifyStellarWalletProof(NETWORK, proof(challenge), ledger, NOW + 299n).status).toBe(
      'valid',
    );
    expect(verifyStellarWalletProof(NETWORK, proof(challenge), ledger, NOW + 300n)).toEqual({
      status: 'invalid',
      reason: 'EXPIRED',
    });
  });

  it('refuses a changed message', () => {
    const challenge = challengeFor(key.address);
    const changed = challenge.text.replace('payouts', 'pay outs');
    expect(
      verifyStellarWalletProof(NETWORK, proof(challenge, changed), { account: null }, NOW),
    ).toEqual({ status: 'invalid', reason: 'MESSAGE_MISMATCH' });
  });

  it('refuses a wrong tag in resources', () => {
    const challenge = challengeFor(key.address, 5n);
    const otherTag = challengeFor(key.address, 6n);
    // Signed over a text naming another tag, which is not the issued text.
    const signed = otherTag.text.replace(otherTag.nonce, challenge.nonce);
    expect(signed).toContain('urn:ujira:tag:6');
    expect(
      verifyStellarWalletProof(NETWORK, proof(challenge, signed), { account: null }, NOW),
    ).toEqual({ status: 'invalid', reason: 'MESSAGE_MISMATCH' });
  });

  it('refuses a wrong signer', () => {
    const challenge = challengeFor(key.address);
    const contract = encodeStrkey(STRKEY_VERSION.contract, new Uint8Array(32).fill(7));
    for (const signer of [contract, encodeMuxedAddress(key.publicKey, 1n), 'GNOTAKEY']) {
      expect(
        verifyStellarWalletProof(
          NETWORK,
          { ...proof(challenge), signer },
          { account: account(key.address) },
          NOW,
        ),
      ).toEqual({ status: 'invalid', reason: 'WRONG_SIGNER' });
    }
  });

  it('refuses a signature by another key or a malformed one', () => {
    const challenge = challengeFor(key.address);
    const other = testKey();
    const ledger = { account: account(key.address) };
    expect(
      verifyStellarWalletProof(NETWORK, proof(challenge, challenge.text, other), ledger, NOW),
    ).toEqual({ status: 'invalid', reason: 'BAD_SIGNATURE' });
    for (const signature of ['', 'AAAA', Buffer.alloc(63).toString('base64')]) {
      expect(
        verifyStellarWalletProof(NETWORK, { ...proof(challenge), signature }, ledger, NOW),
      ).toEqual({ status: 'invalid', reason: 'BAD_SIGNATURE' });
    }
  });

  it('refuses a contract address, which has no key', () => {
    const contract = encodeStrkey(STRKEY_VERSION.contract, new Uint8Array(32).fill(7));
    const challenge = challengeFor(contract);
    expect(verifyStellarWalletProof(NETWORK, proof(challenge), { account: null }, NOW)).toEqual({
      status: 'invalid',
      reason: 'UNSUPPORTED_ACCOUNT',
    });
  });

  it('refuses an account that does not exist', () => {
    const challenge = challengeFor(key.address);
    expect(verifyStellarWalletProof(NETWORK, proof(challenge), { account: null }, NOW)).toEqual({
      status: 'invalid',
      reason: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('applies the signer rules to the key that signed', () => {
    const added = testKey();
    const challenge = challengeFor(key.address);
    const signedByAdded = { ...proof(challenge, challenge.text, added), signer: added.address };
    const withAdded = (weight: number, low: number) => ({
      account: account(key.address, {
        masterWeight: 0,
        thresholds: { low, medium: low, high: low },
        signers: [{ kind: 'ed25519', key: added.address, weight }],
      }),
    });
    expect(verifyStellarWalletProof(NETWORK, signedByAdded, withAdded(2, 2), NOW)).toEqual({
      status: 'valid',
      scheme: 'sep53',
      signer: added.address,
    });
    expect(verifyStellarWalletProof(NETWORK, signedByAdded, withAdded(1, 2), NOW)).toEqual({
      status: 'invalid',
      reason: 'SIGNER_NOT_AUTHORIZED',
    });
    // The master key with weight zero cannot prove the account.
    expect(verifyStellarWalletProof(NETWORK, proof(challenge), withAdded(2, 2), NOW)).toEqual({
      status: 'invalid',
      reason: 'SIGNER_NOT_AUTHORIZED',
    });
  });

  it('refuses a challenge for another network or a ledger read of another account', () => {
    const challenge = challengeFor(key.address);
    expect(() =>
      verifyStellarWalletProof('stellar:pubnet', proof(challenge), { account: null }, NOW),
    ).toThrow(InvalidInputError);
    expect(() =>
      verifyStellarWalletProof(
        NETWORK,
        proof(challenge),
        { account: account(testKey().address) },
        NOW,
      ),
    ).toThrow(InvalidInputError);
  });
});
