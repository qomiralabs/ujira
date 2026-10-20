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
    expect(screen.getByRole('dialog', { name: 'Go to a page' })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(10);
    fireEvent.click(screen.getByRole('option', { name: 'Funding' }));
    expect(push).toHaveBeenCalledWith('/funding?project=grants');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when the shortcut is pressed again', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says what search will cover when nothing matches', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No page matches that/)).toBeTruthy();
  });
});
