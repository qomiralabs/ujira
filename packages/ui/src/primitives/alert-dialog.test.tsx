// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './alert-dialog.js';

afterEach(cleanup);

function renderConfirm(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Revoke this mandate?"
      description="No further payouts can be made under it."
      confirmLabel="Revoke mandate"
      confirmWord="REVOKE"
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm };
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Revoke mandate' });
}

describe('ConfirmDialog', () => {
  it('the danger button stays disabled until the shown word is typed exactly', () => {
    const { onConfirm } = renderConfirm();
    const input = screen.getByLabelText(/type revoke to confirm/i);
    expect(confirmButton().disabled).toBe(true);

    for (const wrong of ['REVOK', 'revoke', ' REVOKE', 'REVOKE ', 'REVOKEE', 'REVOKED']) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(confirmButton().disabled, wrong).toBe(true);
      fireEvent.click(confirmButton());
      expect(onConfirm, wrong).not.toHaveBeenCalled();
    }

    fireEvent.change(input, { target: { value: 'REVOKE' } });
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the word to type inside the question, so it cannot be guessed from the label alone', () => {
    renderConfirm();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('REVOKE')).toBeTruthy();
  });

  it('restates the amount and the recipient, so the action is never abstract', () => {
    renderConfirm({
      description: 'Amara Okafor is paid KSh 1,500.00. This cannot be undone.',
    });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Amara Okafor');
    expect(dialog.textContent).toContain('KSh 1,500.00');
  });

  it('is named and described by its own title and description', () => {
    renderConfirm();
    const dialog = screen.getByRole('alertdialog');
    const title = screen.getByText('Revoke this mandate?');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    expect(document.getElementById(describedBy)?.textContent).toContain('No further payouts');
  });

  it('needs no typing when no word is asked for', () => {
    const { onConfirm } = renderConfirm({ confirmWord: undefined });
    expect(screen.queryByLabelText(/type .* to confirm/i)).toBeNull();
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('clears the typed word when it is closed, so reopening starts locked', () => {
    const { rerender } = render(
      <ConfirmDialog
        open
        title="Revoke this mandate?"
        confirmLabel="Revoke mandate"
        confirmWord="REVOKE"
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/type revoke to confirm/i), {
      target: { value: 'REVOKE' },
    });
    expect(confirmButton().disabled).toBe(false);
    rerender(
      <ConfirmDialog
        open={false}
        title="Revoke this mandate?"
        confirmLabel="Revoke mandate"
        confirmWord="REVOKE"
        onConfirm={vi.fn()}
      />,
    );
    rerender(
      <ConfirmDialog
        open
        title="Revoke this mandate?"
        confirmLabel="Revoke mandate"
        confirmWord="REVOKE"
        onConfirm={vi.fn()}
      />,
    );
    expect(confirmButton().disabled).toBe(true);
  });

  it('uses the danger variant for the confirm button and keeps cancel quiet', () => {
    renderConfirm();
    expect(confirmButton().className).toContain('text-blocked');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('bg-transparent');
  });

  it('locks the dialog while the action is pending', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        pending
        title="Revoke this mandate?"
        confirmLabel="Revoke mandate"
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />,
    );
    const button = screen.getByRole('button', { name: 'Revoke mandate' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
