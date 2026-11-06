// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog.js';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './sheet.js';

afterEach(cleanup);

function PendingDialog({ pending }: { pending: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>Approve payout</DialogTrigger>
      <DialogContent pending={pending}>
        <DialogTitle>Approve this payout?</DialogTitle>
        <DialogDescription>Amara Okafor receives 20,000.00 naira.</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function PendingSheet({ pending }: { pending: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger>Open payout</SheetTrigger>
      <SheetContent pending={pending}>
        <SheetTitle>Payout to Amara Okafor</SheetTitle>
        <SheetDescription>Waiting for approval.</SheetDescription>
      </SheetContent>
    </Sheet>
  );
}

// The first render loads Radix, which is slow on a loaded runner.
describe('Dialog', { timeout: 30_000 }, () => {
  it('Escape does not close while pending is true', () => {
    render(<PendingDialog pending />);
    const dialog = screen.getByRole('dialog', { name: 'Approve this payout?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    // The close button is off too.
    expect(screen.getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(true);
  });

  it('Escape closes once nothing is pending', () => {
    render(<PendingDialog pending={false} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is named by its title and described by its description', () => {
    render(<PendingDialog pending={false} />);
    const dialog = screen.getByRole('dialog', { name: 'Approve this payout?' });
    const described = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(described)?.textContent).toContain('Amara Okafor');
  });

  it('uses the overlay radius and the one overlay shadow', () => {
    render(<PendingDialog pending={false} />);
    const classes = screen.getByRole('dialog').className.split(' ');
    expect(classes).toContain('rounded-overlay');
    expect(classes).toContain('shadow-overlay');
  });
});

describe('Sheet', { timeout: 30_000 }, () => {
  it('Escape does not close while pending is true', () => {
    render(<PendingSheet pending />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('is full screen on a phone and a panel from the right edge above it', () => {
    render(<PendingSheet pending={false} />);
    const classes = screen.getByRole('dialog', { name: 'Payout to Amara Okafor' }).className;
    expect(classes).toContain('w-full');
    expect(classes).toContain('right-0');
    expect(classes).toContain('sm:rounded-overlay');
  });
});
