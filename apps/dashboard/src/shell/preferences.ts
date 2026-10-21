// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { useSyncExternalStore } from 'react';

// Personal display preferences, kept in localStorage and mirrored onto <html>
// as data attributes that the tokens and the rail styles read. The same logic
// runs as an inline script before first paint, so a reload never flashes the
// wrong theme or a rail that then snaps shut.

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export type Rail = 'expanded' | 'collapsed';

import { RAIL_KEY, THEME_KEY } from './preferences-script';

export { RAIL_KEY, THEME_KEY };
const CHANGE_EVENT = 'ujira-preferences';

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    // Storage can be switched off; preferences then last for the page only.
    return undefined;
  }
}

function read(key: string): string | null {
  return storage()?.getItem(key) ?? null;
}

function write(key: string, value: string | null): void {
  const store = storage();
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    // A full or blocked store keeps the preference for this page only.
  }
}

export function readTheme(): Theme {
  const value = document.documentElement.dataset['theme'];
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readRail(): Rail {
  return document.documentElement.dataset['rail'] === 'collapsed' ? 'collapsed' : 'expanded';
}

function notify(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** System removes the attribute, so the tokens follow prefers-color-scheme. */
export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = theme;
  write(THEME_KEY, theme === 'system' ? null : theme);
  notify();
}

export function setRail(rail: Rail): void {
  const root = document.documentElement;
  if (rail === 'collapsed') root.dataset['rail'] = 'collapsed';
  else delete root.dataset['rail'];
  write(RAIL_KEY, rail === 'collapsed' ? 'collapsed' : null);
  notify();
}

/** Applies the stored preferences. The inline script runs the same steps. */
export function restorePreferences(): void {
  const theme = read(THEME_KEY);
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset['theme'] = theme;
  if (read(RAIL_KEY) === 'collapsed') document.documentElement.dataset['rail'] = 'collapsed';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  // Another tab changing the theme or the rail applies here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_KEY && event.key !== RAIL_KEY) return;
    const root = document.documentElement;
    delete root.dataset['theme'];
    delete root.dataset['rail'];
    restorePreferences();
    onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

// The server cannot know either preference, so it renders the defaults and
// the client corrects them right after hydration.
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => 'system');
}

export function useRail(): Rail {
  return useSyncExternalStore(subscribe, readRail, () => 'expanded');
}
