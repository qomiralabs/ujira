// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { useEffect, useId, useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';
import { Input } from './input.js';
import { Label } from './label.js';
import { OVERLAY_PANEL, OVERLAY_SCRIM } from './overlay-styles.js';
import { pendingLock } from './use-pending-lock.js';

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogAction = AlertDialogPrimitive.Action;
export const AlertDialogCancel = AlertDialogPrimitive.Cancel;

export interface AlertDialogContentProps extends ComponentProps<
  typeof AlertDialogPrimitive.Content
> {
  /** A money action is waiting for the server. The dialog cannot be dismissed. */
  pending?: boolean;
}

export function AlertDialogContent({
  className,
  pending = false,
  ...props
}: AlertDialogContentProps) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay data-slot="alert-dialog-overlay" className={OVERLAY_SCRIM} />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          OVERLAY_PANEL,
          'top-1/2 left-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-overlay p-6',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...pendingLock(pending)}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-title text-text', className)}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-body-s text-text-secondary', className)}
      {...props}
    />
  );
}

// The optional props accept an explicit undefined, because callers compute
// them: `confirmWord={rule.irreversible ? 'REVOKE' : undefined}`.
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** The question, as a question. For example "Revoke this mandate?". */
  title: ReactNode;
  /**
   * What will happen, in plain words. For a money action, restate the amount
   * and the recipient here: never make the person remember what they clicked.
   */
  description?: ReactNode | undefined;
  /** The action, in sentence case. For example "Revoke mandate". */
  confirmLabel: string;
  cancelLabel?: string | undefined;
  /**
   * Ask the person to type this word before the action unlocks. Use it for
   * anything that cannot be undone: pause, revoke, delete. Leave it out and
   * the action is available straight away.
   */
  confirmWord?: string | undefined;
  /** The action is waiting for the server. The dialog cannot be dismissed. */
  pending?: boolean | undefined;
  onConfirm: () => void;
  children?: ReactNode | undefined;
}

/**
 * A confirmation for an action that cannot be undone. It restates what will
 * happen, and for the dangerous ones it asks the person to type a word first,
 * so the action cannot be reached by a stray Enter on a focused button.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmWord,
  pending = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState('');

  // Closing clears the word, so reopening always starts locked. Without this
  // a dialog that was cancelled mid-typing would reopen already unlocked.
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  // Exact match: no trimming and no case folding, so the word has to be read
  // and typed rather than guessed at.
  const unlocked = confirmWord === undefined || typed === confirmWord;
  const blocked = pending || !unlocked;

  return (
    <AlertDialog open={open} {...(onOpenChange ? { onOpenChange } : {})}>
      <AlertDialogContent pending={pending}>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {description === undefined ? null : (
          <AlertDialogDescription>{description}</AlertDialogDescription>
        )}
        {children}
        {confirmWord === undefined ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>
              Type{' '}
              <span className="mx-1 font-mono text-data text-text select-all">{confirmWord}</span>{' '}
              to confirm
            </Label>
            <Input
              id={inputId}
              value={typed}
              disabled={pending}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </div>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel asChild>
            <Button variant="ghost" disabled={pending}>
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          {/*
           * Not AlertDialogAction: that closes the dialog on click, which
           * would take the question away before the server has answered.
           * The caller closes it when the action settles.
           */}
          <Button
            variant="danger"
            loading={pending}
            disabled={!unlocked}
            onClick={() => {
              if (!blocked) onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
