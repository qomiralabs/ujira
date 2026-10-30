// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import {
  catalogueFor,
  DEFAULT_LOCALE,
  fill,
  isLocale,
  languageOf,
  LOCALES,
  translator,
} from './catalogue.js';
import { en } from './en.js';

describe('catalogue', () => {
  it('ships English first', () => {
    expect(LOCALES).toEqual(['en']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(catalogueFor('en')).toBe(en);
  });

  it('reads a tag with a region as its language', () => {
    expect(languageOf('en-NG')).toBe('en');
    expect(languageOf('EN')).toBe('en');
    expect(languageOf('')).toBe('');
    expect(catalogueFor('en-NG')).toBe(en);
  });

  it('falls back to English rather than showing a key', () => {
    expect(isLocale('ha')).toBe(false);
    expect(catalogueFor('ha')).toBe(en);
    expect(translator('ha')('name.heading')).toBe(en['name.heading']);
  });

  it('fills placeholders and leaves an unfilled one in plain sight', () => {
    expect(fill('Step {step} of {total}', { step: '2', total: '4' })).toBe('Step 2 of 4');
    expect(fill('Step {step} of {total}', { step: '2' })).toBe('Step 2 of {total}');
    expect(fill('No placeholders here')).toBe('No placeholders here');
  });

  it('translates with values', () => {
    expect(translator('en')('widget.progress', { step: '1', total: '4' })).toBe('Step 1 of 4');
  });

  it('names the one payout method open today exactly', () => {
    expect(en['method.wallet.name']).toBe('USDC to your Stellar wallet');
  });

  it('carries the white label byline and nothing else about UJIRA', () => {
    expect(en['footer.byline']).toBe('Payouts by UJIRA');
    const others = Object.entries(en).filter(
      ([key, value]) => key !== 'footer.byline' && value.includes('UJIRA'),
    );
    expect(others).toEqual([]);
  });

  it('keeps the dashes the house style bans out of the copy', () => {
    // By code point, so this file stays free of them too.
    const banned = [0x2013, 0x2014];
    const offenders = Object.entries(en).filter(([, value]) => {
      for (const character of value) {
        if (banned.includes(character.codePointAt(0) ?? 0)) return true;
      }
      return false;
    });
    expect(offenders).toEqual([]);
  });

  it('gives every choice a line that says what it is', () => {
    expect([
      [en['method.wallet.name'], en['method.wallet.line']],
      [en['method.bank.name'], en['method.bank.line']],
      [en['method.mobile.name'], en['method.mobile.line']],
      [en['method.cash.name'], en['method.cash.line']],
    ]).toEqual([
      ['USDC to your Stellar wallet', 'Paid in USDC to a wallet you hold the keys to.'],
      ['Bank transfer', 'Paid into your own bank account, in your local currency.'],
      ['Mobile money', 'Paid to your mobile money number, in your local currency.'],
      ['Cash pickup', 'Collected as cash from an agent near you, in your local currency.'],
    ]);
  });

  it('shows no amount, so no currency sign has to be drawn', () => {
    const amounts = Object.entries(en).filter(([, value]) => /[\d.,]*\d\s*[A-Z]{3}\b/.test(value));
    expect(amounts).toEqual([]);
  });
});
