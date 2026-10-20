// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThemeSwitch } from './theme-switch';

function open(): void {
  fireEvent.keyDown(screen.getByRole('button', { name: /Choose a theme/ }), { key: 'Enter' });
}

describe('ThemeSwitch', () => {
  it('names the current theme in words and starts on the system setting', () => {
    render(<ThemeSwitch />);
    const trigger = screen.getByRole('button', { name: 'Theme: System. Choose a theme' });
    expect(trigger.textContent).toContain('System');
  });

  it('offers the three modes, each named, with the current one marked', () => {
    render(<ThemeSwitch />);
    open();
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('applies and remembers the choice', () => {
    render(<ThemeSwitch />);
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(screen.getByRole('button', { name: /Choose a theme/ }).textContent).toContain('Dark');
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });

  it('marks the chosen mode with an outline and a mark, never a fill alone', () => {
    render(<ThemeSwitch />);
    open();
    const chosen = screen.getByRole('menuitemradio', { name: 'System' });
    const other = screen.getByRole('menuitemradio', { name: 'Dark' });
    expect(chosen.className).toContain('data-[state=checked]:chosen-ring');
    // The mark is carried as well as the ground.
    expect(chosen.querySelectorAll('svg')).toHaveLength(2);
    expect(other.querySelectorAll('svg')).toHaveLength(1);
  });

  it('gives the row Enter acts on the shared focus ring', () => {
    render(<ThemeSwitch />);
    open();
    expect(screen.getByRole('menuitemradio', { name: 'Light' }).className).toContain(
      'data-highlighted:focus-ring-inset',
    );
  });
});
