// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import {
  catalogueFor,
  DEFAULT_LOCALE,
  DRAFTS,
  fill,
  flagged,
  isLocale,
  languageOf,
  LOCALES,
  readyLocales,
  resolveLocale,
  translator,
} from './catalogue.js';
import { en } from './en.js';
import { fr } from './fr.js';
import { sw } from './sw.js';

describe('catalogue', () => {
  it('has a file for English and the seven launch languages', () => {
    expect(LOCALES).toEqual(['en', 'ha', 'yo', 'ig', 'sw', 'fr', 'pt', 'es']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(catalogueFor('en')).toBe(en);
  });

  it('offers a language only once nothing in it waits for a translator', () => {
    expect(readyLocales()).toEqual(['en', 'sw', 'fr', 'pt', 'es']);
    for (const locale of ['ha', 'yo', 'ig'] as const) {
      expect(flagged(DRAFTS[locale]).length).toBeGreaterThan(0);
      expect(catalogueFor(locale)).toBe(en);
    }
  });

  it('reads a tag with a region as its language', () => {
    expect(languageOf('en-NG')).toBe('en');
    expect(languageOf('EN')).toBe('en');
    expect(languageOf('')).toBe('');
    expect(catalogueFor('en-NG')).toBe(en);
    expect(catalogueFor('fr-SN')).toBe(fr);
    expect(catalogueFor('sw-KE')).toBe(sw);
  });

  it('takes the page language first, then the browser, then English', () => {
    expect(resolveLocale('sw', ['fr-FR'])).toBe('sw');
    expect(resolveLocale('', ['de-DE', 'pt-BR', 'fr'])).toBe('pt');
    expect(resolveLocale('', ['yo-NG', 'en-NG'])).toBe('en');
    expect(resolveLocale('', [])).toBe('en');
    // A page that asked for a language we cannot show yet gets English,
    // not the browser's, since the page chose on purpose.
    expect(resolveLocale('yo', ['fr'])).toBe('en');
    expect(resolveLocale('klingon', ['fr'])).toBe('en');
  });

  it('falls back to English rather than showing a key', () => {
    expect(isLocale('de')).toBe(false);
    expect(catalogueFor('de')).toBe(en);
    expect(translator('ha')('name.heading')).toBe(en['name.heading']);
  });

  it('fills placeholders and leaves an unfilled one in plain sight', () => {
    expect(fill('Step {step} of {total}', { step: '2', total: '4' })).toBe('Step 2 of 4');
    expect(fill('Step {step} of {total}', { step: '2' })).toBe('Step 2 of {total}');
    expect(fill('No placeholders here')).toBe('No placeholders here');
  });

  it('translates with values', () => {
    expect(translator('en')('widget.progress', { step: '1', total: '4' })).toBe('Step 1 of 4');
    expect(translator('fr')('widget.progress', { step: '1', total: '4' })).toBe('Étape 1 sur 4');
  });

  it('names the one payout method open today exactly', () => {
    expect(en['method.wallet.name']).toBe('USDC to your Stellar wallet');
  });

  it('carries the white label byline and nothing else about UJIRA, in every language', () => {
    for (const locale of LOCALES) {
      const draft = DRAFTS[locale];
      expect(draft['footer.byline'], locale).toBe('Payouts by UJIRA');
      const others = Object.entries(draft).filter(
        ([key, value]) => key !== 'footer.byline' && value?.includes('UJIRA') === true,
      );
      expect(others, locale).toEqual([]);
    }
  });

  it('keeps the dashes the house style bans out of the copy, in every language', () => {
    // By code point, so this file stays free of them too.
    const banned = [0x2013, 0x2014];
    for (const locale of LOCALES) {
      const offenders = Object.entries(DRAFTS[locale]).filter(([, value]) => {
        for (const character of value ?? '') {
          if (banned.includes(character.codePointAt(0) ?? 0)) return true;
        }
        return false;
      });
      expect(offenders, locale).toEqual([]);
    }
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
