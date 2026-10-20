// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThemeSwitch } from './theme-switch';

describe('ThemeSwitch', () => {
  it('is a labelled group of three radios that starts on the system setting', () => {
    render(<ThemeSwitch />);
    expect(screen.getByRole('group', { name: 'Theme' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual([
      'system',
      'light',
      'dark',
    ]);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Match system' }).checked).toBe(
      true,
    );
  });

  it('applies and remembers the choice', () => {
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Dark' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Match system' }));
    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });
});
