// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { FOCUS_RING } from './focus-ring.js';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** The dimmed page behind every overlay. */
export const OVERLAY = 'fixed inset-0 z-40 bg-teal-ink/60';

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /**
   * True while a money action waits for the server. Escape, a click outside
   * and the close button do nothing until it is false, so a payout can never
   * be half dismissed.
   */
  pending?: boolean;
  /** The words for the close button, read by screen readers. */
  closeLabel?: string;
  /** Hides the close button, for a dialog whose actions already close it. */
  hideClose?: boolean;
}

/**
 * A centred dialog on the single overlay shadow and the 14px overlay radius.
 * Focus moves in, stays in and returns to the trigger when it closes.
 */
export function DialogContent({
  className,
  children,
  pending = false,
  closeLabel = 'Close',
  hideClose = false,
  onEscapeKeyDown,
  onPointerDownOutside,
  onInteractOutside,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={OVERLAY} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        aria-busy={pending || undefined}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
          onEscapeKeyDown?.(event);
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
          onPointerDownOutside?.(event);
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
          onInteractOutside?.(event);
        }}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
          'rounded-overlay border border-rule bg-surface p-6 text-text shadow-overlay',
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            disabled={pending}
            className={cn(
              'absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-control text-text-secondary hover:text-text disabled:opacity-50',
              FOCUS_RING,
            )}
          >
            <X aria-hidden="true" strokeWidth={1.5} className="size-4" />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('pr-8 text-title text-text', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-body-s text-text-secondary', className)}
      {...props}
    />
  );
}

/** The row of actions at the foot of a dialog: the one thing to do last, on the right. */
export function DialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
    >
      {children}
    </div>
  );
}
