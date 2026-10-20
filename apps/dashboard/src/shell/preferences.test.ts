// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PREFERENCES_SCRIPT, RAIL_KEY, THEME_KEY } from './preferences-script';
import {
  readRail,
  readTheme,
  restorePreferences,
  setRail,
  setTheme,
  useRail,
  useTheme,
} from './preferences';

const root = () => document.documentElement;

function runInlineScript(): void {
  const script = document.createElement('script');
  script.textContent = PREFERENCES_SCRIPT;
  document.head.append(script);
  script.remove();
}

describe('preferences', () => {
  it('follows the system until a theme is picked, and remembers the pick', () => {
    expect(readTheme()).toBe('system');
    setTheme('dark');
    expect(root().dataset['theme']).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(readTheme()).toBe('dark');
    setTheme('system');
    expect(root().dataset['theme']).toBeUndefined();
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('remembers a collapsed rail', () => {
    expect(readRail()).toBe('expanded');
    setRail('collapsed');
    expect(root().dataset['rail']).toBe('collapsed');
    expect(localStorage.getItem(RAIL_KEY)).toBe('collapsed');
    setRail('expanded');
    expect(root().dataset['rail']).toBeUndefined();
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });

  it.each([
    [{ [THEME_KEY]: 'light', [RAIL_KEY]: 'collapsed' }],
    [{ [THEME_KEY]: 'dark' }],
    [{ [THEME_KEY]: 'sepia', [RAIL_KEY]: 'wide' }],
    [{}],
  ])('applies the same stored values in the inline script as at runtime: %o', (stored) => {
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
    restorePreferences();
    const expected = Object.fromEntries(Object.entries(root().dataset));
    delete root().dataset['theme'];
    delete root().dataset['rail'];
    runInlineScript();
    expect(Object.fromEntries(Object.entries(root().dataset))).toEqual(expected);
  });

  it('keeps working for the page when storage is blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setTheme('light');
    expect(readTheme()).toBe('light');
    spy.mockRestore();
  });

  it('keeps working when storage cannot be reached at all', () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    setRail('collapsed');
    restorePreferences();
    expect(readRail()).toBe('collapsed');
    spy.mockRestore();
  });

  it('re-renders subscribers on change, and on a change from another tab', () => {
    const theme = renderHook(() => useTheme());
    const rail = renderHook(() => useRail());
    act(() => {
      setTheme('light');
    });
    expect(theme.result.current).toBe('light');
    act(() => {
      localStorage.setItem(THEME_KEY, 'dark');
      localStorage.setItem(RAIL_KEY, 'collapsed');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }));
    });
    expect(theme.result.current).toBe('dark');
    expect(rail.result.current).toBe('collapsed');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    });
    expect(theme.result.current).toBe('dark');
    theme.unmount();
    rail.unmount();
  });
});
