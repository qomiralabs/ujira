// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CommandPalette, isPaletteShortcut } from './command-palette';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function Harness() {
  const [open, setOpen] = useState(false);
  return <CommandPalette project="grants" open={open} onOpenChange={setOpen} />;
}

describe('CommandPalette', () => {
  it.each([
    [{ key: 'k', metaKey: true }, true],
    [{ key: 'K', ctrlKey: true }, true],
    [{ key: 'k' }, false],
    [{ key: 'k', ctrlKey: true, altKey: true }, false],
    [{ key: 'j', metaKey: true }, false],
  ])('treats %o as the shortcut: %s', (init, expected) => {
    expect(isPaletteShortcut(new KeyboardEvent('keydown', init))).toBe(expected);
  });

  it('opens with the shortcut, lists every page and goes to the chosen one', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Find a page' })).toBeTruthy();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(10);
    // Every choice says what the page is for, never a bare list of names.
    expect(options[0]?.textContent).toBe(
      'OverviewWhat this project has paid, what is waiting, and how long the money will last.',
    );
    fireEvent.click(screen.getByRole('option', { name: /^Funding/ }));
    expect(push).toHaveBeenCalledWith('/funding?project=grants');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('finds a page by what it does, not only by its name', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'money' } });
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names.some((name) => name.startsWith('Funding'))).toBe(true);
  });

  it('closes when the shortcut is pressed again', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says plainly when nothing matches', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No page matches that. Try another word.')).toBeTruthy();
  });
});
