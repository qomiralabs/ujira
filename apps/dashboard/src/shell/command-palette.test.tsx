// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    // A different shortcut, which this one must not swallow.
    [{ key: 'k', ctrlKey: true, shiftKey: true }, false],
    [{ key: 'K', metaKey: true, shiftKey: true }, false],
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

  // The list is re-sorted after the keystroke, so each search waits for the
  // order to settle rather than reading it mid flight.
  async function firstPage(term: string): Promise<string> {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: term } });
    let first = '';
    await waitFor(() => {
      first = screen.getAllByRole('option')[0]?.textContent ?? '';
      expect(first).not.toBe('');
    });
    return first;
  }

  it.each([
    ['pay', 'Payouts'],
    ['approve', 'Approvals'],
    ['receipt', 'Receipts'],
    ['mandate', 'Mandates'],
  ])('puts the page named for %s first, not one that merely mentions it', async (term, page) => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(async () => {
      expect(await firstPage(term)).toMatch(new RegExp(`^${page}`));
    });
  });

  it('still finds a page by what it does when no name matches', async () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'money' } });
    await waitFor(() => {
      const names = screen.getAllByRole('option').map((option) => option.textContent);
      expect(names.some((name) => name.startsWith('Funding'))).toBe(true);
    });
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
