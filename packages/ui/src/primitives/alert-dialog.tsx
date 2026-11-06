// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';
import { OVERLAY } from './dialog.js';
import { TEXT_CONTROL } from './control-styles.js';

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What will happen, as a question or a statement: "Pause this mandate?" */
  title: string;
  /** Restates exactly what the action does: the amount, the recipient, what stops. */
  description: ReactNode;
  /** The words on the button that does it: "Pause mandate". */
  confirmLabel: string;
  /** The icon a danger action carries, since it has no colour of its own. */
  confirmIcon: ReactElement;
  cancelLabel?: string;
  onConfirm: () => void;
  /** True while the server works on it: the dialog cannot be dismissed and the button shows busy. */
  pending?: boolean;
  /**
   * For danger actions such as pause and revoke: the word the person must
   * type, exactly, before the button turns on.
   */
  confirmationWord?: string;
}

/**
 * A confirmation that is hard to trigger by accident. It restates what will
 * happen, keeps focus inside, never closes on a click outside, and cannot be
 * dismissed at all while the money action is pending. With a confirmation
 * word, the action stays off until the word is typed exactly.
 */
export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmIcon,
  cancelLabel = 'Cancel',
  onConfirm,
  pending = false,
  confirmationWord,
}: AlertDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const matches = confirmationWord === undefined || typed === confirmationWord;

  // The dialog is opened from the caller's own button rather than a Radix
  // trigger, so Radix does not know where focus came from. The element that
  // had focus is noted as it opens, before the dialog moves focus inside
  // (layout effects run before the focus scope's own effect), and focus goes
  // back there when it closes.
  const returnFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) {
      returnFocus.current = document.activeElement;
    }
  }, [open]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) setTyped('');
        onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY} />
        <DialogPrimitive.Content
          role="alertdialog"
          data-slot="alert-dialog"
          aria-busy={pending || undefined}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocus.current;
            if (target?.isConnected === true) {
              event.preventDefault();
              target.focus();
            }
          }}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
            'rounded-overlay border border-rule bg-surface p-6 text-text shadow-overlay',
          )}
        >
          <DialogPrimitive.Title className="text-title text-text">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description asChild>
            <div className="text-body-s text-text-secondary">{description}</div>
          </DialogPrimitive.Description>
          {confirmationWord === undefined ? null : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-body-s text-text">
                Type <span className="font-mono text-data">{confirmationWord}</span> to confirm
              </label>
              <input
                id={inputId}
                data-slot="confirmation-input"
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
                className={cn(TEXT_CONTROL, 'h-10 px-3 font-mono')}
              />
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogPrimitive.Close asChild>
              <Button variant="secondary" disabled={pending}>
                {cancelLabel}
              </Button>
            </DialogPrimitive.Close>
            <Button
              variant="danger"
              icon={confirmIcon}
              loading={pending}
              disabled={!matches}
              onClick={() => {
                if (matches && !pending) onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
