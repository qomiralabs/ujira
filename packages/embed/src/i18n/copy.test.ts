// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Each payout path speaks its own language. The wallet option may name USDC
// and Stellar, because that is what the person chose. Someone paid in their
// own currency by bank, mobile money or cash reads no chain, token or
// transaction words at all.

import { describe, expect, it } from 'vitest';

import { methodById, PAYOUT_METHODS } from '../methods.js';
import { en } from './en.js';

const CHAIN_WORDS =
  /\b(?:usdc|usd coin|stellar|xlm|lumens?|tokens?|crypto\w*|blockchain|chain|wallet|trustline|memo|transaction|hash|stablecoin|anchor|sep-?\d+)\b/i;

/** Every key a local currency path shows: its name, its line and its question. */
function localCurrencyKeys(): (keyof typeof en)[] {
  return PAYOUT_METHODS.filter((method) => method.id !== 'wallet').flatMap((method) => [
    method.name,
    method.line,
    ...Object.values(method.destination).filter(
      (value): value is keyof typeof en => typeof value === 'string' && value in en,
    ),
  ]);
}

describe('copy', () => {
  it('the wallet option is labelled "USDC to your Stellar wallet"', () => {
    const wallet = methodById('wallet');
    expect(wallet === undefined ? '' : en[wallet.name]).toBe('USDC to your Stellar wallet');
  });

  it('bank, mobile money and cash strings contain no USDC, chain or token words', () => {
    const keys = localCurrencyKeys();
    // Three methods, each with a name, a line and six destination strings.
    expect(keys).toHaveLength(24);
    const offenders = keys.filter((key) => CHAIN_WORDS.test(en[key]));
    expect(offenders).toEqual([]);
  });

  it('the identity check an anchor runs speaks the same local language', () => {
    // These show on a bank, mobile money or cash path, and on the wallet path
    // too, so they carry no chain words whichever path a person is on.
    const keys = (Object.keys(en) as (keyof typeof en)[]).filter(
      (key) => key.startsWith('verify.') && !key.startsWith('verify.self.'),
    );
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((key) => CHAIN_WORDS.test(en[key]))).toEqual([]);
  });

  it('would catch a chain word if one slipped in', () => {
    expect(CHAIN_WORDS.test('Paid in USDC to your bank')).toBe(true);
    expect(CHAIN_WORDS.test('Sent over the Stellar network')).toBe(true);
    expect(CHAIN_WORDS.test('Paid into your own bank account, in your local currency.')).toBe(
      false,
    );
  });

  it('says "paid", never "sent funds" or "transferred"', () => {
    const offenders = Object.entries(en).filter(([, value]) =>
      /\b(?:sent funds|transferred|users?|workers?)\b/i.test(value),
    );
    expect(offenders).toEqual([]);
  });
});
