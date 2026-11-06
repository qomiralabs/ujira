// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../primitives/button.js';
import { DetailSheet } from './detail-sheet.js';

afterEach(cleanup);

/** Opened from a table row the way a screen does it: state, not a trigger. */
function RowAndSheet({ pending = false }: { pending?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Amara Okafor
      </button>
      <DetailSheet
        open={open}
        onOpenChange={setOpen}
        title="Amara Okafor"
        amount={<span>₦20,000.00</span>}
        description="Waiting for approval"
        footer={<Button variant="primary">Approve payout</Button>}
        pending={pending}
      >
        <p>The timeline goes here.</p>
      </DetailSheet>
    </>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('DetailSheet', { timeout: 30_000 }, () => {
  it('leads with the amount and the title, then the body and one footer action', () => {
    render(<RowAndSheet />);
    fireEvent.click(screen.getByRole('button', { name: 'Amara Okafor' }));
    const sheet = screen.getByRole('dialog', { name: 'Amara Okafor' });
    const order = [...sheet.querySelectorAll('[data-slot^="detail-sheet-"]')].map((node) =>
      node.getAttribute('data-slot'),
    );
    expect(order).toEqual([
      'detail-sheet-header',
      'detail-sheet-amount',
      'detail-sheet-body',
      'detail-sheet-footer',
    ]);
    expect(
      sheet.querySelector('[data-slot="detail-sheet-footer"]')?.querySelectorAll('button'),
    ).toHaveLength(1);
  });

  it('returns focus to the row that opened it', async () => {
    render(<RowAndSheet />);
    const row = screen.getByRole('button', { name: 'Amara Okafor' });
    row.focus();
    fireEvent.click(row);
    expect(document.activeElement).not.toBe(row);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('stays open on Escape while a money action is pending', () => {
    render(<RowAndSheet pending />);
    fireEvent.click(screen.getByRole('button', { name: 'Amara Okafor' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('is controlled from outside, so a screen can keep it in the URL', () => {
    const { rerender } = render(
      <DetailSheet open={false} onOpenChange={() => undefined} title="Payout">
        <p>Body</p>
      </DetailSheet>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <DetailSheet open onOpenChange={() => undefined} title="Payout">
        <p>Body</p>
      </DetailSheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Payout' })).toBeTruthy();
  });
});
