// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Looks up copy by key. English ships first; Hausa, Yoruba, Igbo, Swahili,
// French, Portuguese and Spanish follow, each as a file next to en.ts that is
// registered below. A tag with a region, such as en-NG, uses the language
// file. An unknown language falls back to English rather than showing a key.

import { en } from './en.js';

/** Every key in the catalogue. A key outside this set is a type error. */
export type MessageKey = keyof typeof en;

/** One language file: the same keys as English, translated. */
export type Catalogue = Readonly<Record<MessageKey, string>>;

export const LOCALES = ['en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

const CATALOGUES: Readonly<Record<Locale, Catalogue>> = { en };

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** The language part of a tag, lower cased: en-NG and EN both give en. */
export function languageOf(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}

export function catalogueFor(tag: string): Catalogue {
  const language = languageOf(tag);
  return isLocale(language) ? CATALOGUES[language] : CATALOGUES[DEFAULT_LOCALE];
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
