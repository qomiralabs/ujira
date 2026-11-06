// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertDialog } from './alert-dialog.js';

afterEach(cleanup);

/** Opened from the caller's own button, the way a screen uses it. */
function PauseFromButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Pause this mandate
      </button>
      <AlertDialog
        open={open}
        onOpenChange={setOpen}
        title="Pause this mandate?"
        description="No payouts leave until you resume it."
        confirmLabel="Pause mandate"
        confirmIcon={<span />}
        onConfirm={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

function renderPause(props: Partial<Parameters<typeof AlertDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <AlertDialog
      open
      onOpenChange={onOpenChange}
      title="Pause this mandate?"
      description="No payouts leave Annotation batch 14 until you resume it."
      confirmLabel="Pause mandate"
      confirmIcon={<span data-testid="icon" />}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onOpenChange };
}

function confirmButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Pause mandate' });
}

describe('AlertDialog', { timeout: 30_000 }, () => {
  it('returns focus to the button that opened it, on Cancel and on confirm', async () => {
    render(<PauseFromButton />);
    const opener = screen.getByRole('button', { name: 'Pause this mandate' });
    for (const close of ['Cancel', 'Pause mandate']) {
      opener.focus();
      fireEvent.click(opener);
      expect(screen.getByRole('alertdialog')).toBeTruthy();
      expect(document.activeElement).not.toBe(opener);
      fireEvent.click(screen.getByRole('button', { name: close }));
      // Radix restores focus after its close animation frame.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.queryByRole('alertdialog'), close).toBeNull();
      expect(document.activeElement, close).toBe(opener);
    }
  });

  it('the danger button stays disabled until the shown word is typed exactly', () => {
    const { onConfirm } = renderPause({ confirmationWord: 'pause' });
    const input = screen.getByRole('textbox', { name: 'Type pause to confirm' });
    expect(confirmButton().hasAttribute('disabled')).toBe(true);
    for (const attempt of ['p', 'paus', 'Pause', 'PAUSE', ' pause', 'pause ', 'pauses']) {
      fireEvent.change(input, { target: { value: attempt } });
      expect(confirmButton().hasAttribute('disabled'), attempt).toBe(true);
      fireEvent.click(confirmButton());
    }
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'pause' } });
    expect(confirmButton().hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('is an alert dialog that restates what will happen', () => {
    renderPause();
    const dialog = screen.getByRole('alertdialog', { name: 'Pause this mandate?' });
    expect(dialog.textContent).toContain('No payouts leave Annotation batch 14');
    // Without a word the action is on at once, still behind this step.
    expect(confirmButton().hasAttribute('disabled')).toBe(false);
  });

  it('cannot be dismissed while the action is pending', () => {
    const { onOpenChange, onConfirm } = renderPause({ pending: true });
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirmButton().getAttribute('aria-busy')).toBe('true');
  });

  it('closes on Escape and Cancel when nothing is pending', () => {
    const { onOpenChange } = renderPause();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
