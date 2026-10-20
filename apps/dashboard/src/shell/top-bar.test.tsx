// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopBar } from './top-bar';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TopBar', () => {
  it('opens the command palette from the search button', () => {
    render(<TopBar project="labelling" onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Find a page/ }));
    expect(screen.getByRole('dialog', { name: 'Find a page' })).toBeTruthy();
  });

  it('shows Ctrl K off Apple devices and the command key on them', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' });
    const { unmount } = render(<TopBar project="labelling" onProjectChange={vi.fn()} />);
    const search = screen.getByRole('button', { name: /Find a page/ });
    expect(search.textContent).toContain('Ctrl K');
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Control+K');
    unmount();
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' });
    render(<TopBar project="labelling" onProjectChange={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /Find a page/ }).getAttribute('aria-keyshortcuts'),
    ).toBe('Meta+K');
  });

  it('holds the drawer button and the theme switch', () => {
    render(<TopBar project="labelling" onProjectChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Theme' })).toBeTruthy();
  });
});
