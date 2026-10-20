// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog.js';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet.js';

afterEach(cleanup);

function renderDialog(props: { pending?: boolean; onOpenChange: (open: boolean) => void }) {
  const { pending, onOpenChange } = props;
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent pending={pending ?? false}>
        <DialogTitle>Approve this payout?</DialogTitle>
        <DialogDescription>Amara Okafor is paid KSh 1,500.00.</DialogDescription>
      </DialogContent>
    </Dialog>,
  );
}

describe('Dialog', () => {
  it('Escape does not close while pending is true', () => {
    const onOpenChange = vi.fn();
    renderDialog({ pending: true, onOpenChange });
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Escape closes when nothing is pending', () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('hides the close button while pending, so there is no dead control', () => {
    const onOpenChange = vi.fn();
    renderDialog({ pending: true, onOpenChange });
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    cleanup();
    renderDialog({ onOpenChange });
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('marks itself busy while pending, so the wait is announced', () => {
    renderDialog({ pending: true, onOpenChange: vi.fn() });
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
  });

  it('is named by its title and described by its description', () => {
    renderDialog({ onOpenChange: vi.fn() });
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe(
      screen.getByText('Approve this payout?').id,
    );
    expect(dialog.getAttribute('aria-describedby')).toBe(
      screen.getByText('Amara Okafor is paid KSh 1,500.00.').id,
    );
  });

  it('uses the 14px overlay radius and the one overlay shadow', () => {
    renderDialog({ onOpenChange: vi.fn() });
    const classes = screen.getByRole('dialog').className;
    expect(classes).toContain('rounded-overlay');
    expect(classes).toContain('shadow-overlay');
  });
});

describe('Sheet', () => {
  it('Escape does not close while pending is true', () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent pending>
          <SheetTitle>Payout to Amara Okafor</SheetTitle>
          <SheetDescription>KSh 1,500.00, waiting to settle.</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('opens from the right by default, rounded on the edge that faces the page', () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Payout detail</SheetTitle>
          <SheetDescription>One payout.</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    const sheet = screen.getByRole('dialog');
    expect(sheet.getAttribute('data-side')).toBe('right');
    // The 14px overlay radius, on the inner edge only: the outer edges meet
    // the window, so rounding them would show a sliver of the page behind.
    expect(sheet.className).toContain('rounded-l-overlay');
    expect(sheet.className).not.toContain('rounded-r-overlay');
  });

  it.each(['right', 'left', 'bottom'] as const)('opens from the %s side', (side) => {
    render(
      <Sheet open>
        <SheetContent side={side}>
          <SheetTitle>Payout detail</SheetTitle>
          <SheetDescription>One payout.</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole('dialog').getAttribute('data-side')).toBe(side);
  });
});
