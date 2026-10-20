// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MobileNav } from './mobile-nav';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <MobileNav project="labelling" onProjectChange={vi.fn()} open={open} onOpenChange={setOpen} />
  );
}

function dialog(): HTMLDialogElement {
  const element = document.querySelector('dialog');
  if (!element) throw new Error('no dialog');
  return element;
}

describe('MobileNav', () => {
  it('opens as a modal dialog and closes from its close button', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    expect(dialog().open).toBe(false);
    fireEvent.click(opener);
    expect(dialog().open).toBe(true);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(dialog().open).toBe(false);
  });

  it('closes when a page is chosen and when the backdrop is clicked', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('link', { name: 'Receipts' }));
    expect(dialog().open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(dialog());
    expect(dialog().open).toBe(false);
  });

  it('closes on Escape, which the browser reports as a close event', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent(dialog(), new Event('close'));
    expect(
      screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });
});
