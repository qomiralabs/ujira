// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Looks up copy by key. English is the source; every other language is a
// file next to en.ts with every key in it, registered below. A tag with a
// region, such as fr-SN, uses the language file.
//
// A string nobody has translated yet is null in its file, flagged for a
// translator, never filled with a guess. A language is offered only once it
// has no flagged string left: half a screen in one language and half in
// another serves nobody, so until then a request for it gets English whole.

import { en } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { ha } from './ha.js';
import { ig } from './ig.js';
import { pt } from './pt.js';
import { sw } from './sw.js';
import { yo } from './yo.js';

/** Every key in the catalogue. A key outside this set is a type error. */
export type MessageKey = keyof typeof en;

/** One language file: the same keys as English, translated. */
export type Catalogue = Readonly<Record<MessageKey, string>>;

/** A language file in progress: null marks a string waiting for a translator. */
export type Draft = Readonly<Record<MessageKey, string | null>>;

/** Every language with a file, in the order they were planned. */
export const LOCALES = ['en', 'ha', 'yo', 'ig', 'sw', 'fr', 'pt', 'es'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const DRAFTS: Readonly<Record<Locale, Draft>> = { en, ha, yo, ig, sw, fr, pt, es };

/**
 * Languages whose letters stack diacritics, a dot below and a tone mark on
 * one letter, which need
 * the taller line height the brand sets for them.
 */
export const STACKED_DIACRITICS: readonly Locale[] = ['yo', 'ig', 'ha'];

/** The keys of a draft still waiting for a translator. */
export function flagged(draft: Draft): MessageKey[] {
  return (Object.keys(en) as MessageKey[]).filter((key) => {
    const value = draft[key];
    return typeof value !== 'string' || value.trim() === '';
  });
}

function complete(draft: Draft): Catalogue | undefined {
  return flagged(draft).length === 0 ? (draft as Catalogue) : undefined;
}

const READY: ReadonlyMap<Locale, Catalogue> = new Map(
  LOCALES.flatMap((locale) => {
    const catalogue = complete(DRAFTS[locale]);
    return catalogue === undefined ? [] : [[locale, catalogue] as const];
  }),
);

/** The languages a person can be shown today. */
export function readyLocales(): Locale[] {
  return LOCALES.filter((locale) => READY.has(locale));
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** The language part of a tag, lower cased: en-NG and EN both give en. */
export function languageOf(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}

function readyFor(tag: string): Locale | undefined {
  const language = languageOf(tag.trim());
  return isLocale(language) && READY.has(language) ? language : undefined;
}

/**
 * The language to show: the page's choice when it made one we can show,
 * then the reader's browser languages in their order, then English.
 */
export function resolveLocale(chosen: string, browser: readonly string[] = []): Locale {
  if (chosen.trim() !== '') return readyFor(chosen) ?? DEFAULT_LOCALE;
  for (const tag of browser) {
    const found = readyFor(tag);
    if (found !== undefined) return found;
  }
  return DEFAULT_LOCALE;
}

export function catalogueFor(tag: string): Catalogue {
  return READY.get(readyFor(tag) ?? DEFAULT_LOCALE) ?? en;
}

/**
 * Fills {name} placeholders. A placeholder with no value is left as it is, so
 * a missing value shows up in the tests instead of throwing mid render.
 */
export function fill(template: string, values: Readonly<Record<string, string>> = {}): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export type Translate = (key: MessageKey, values?: Readonly<Record<string, string>>) => string;

export function translator(tag: string): Translate {
  const catalogue = catalogueFor(tag);
  return (key, values) => fill(catalogue[key], values);
}
