// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { OVERLAY } from './dialog.js';
import { FOCUS_RING } from './focus-ring.js';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export interface SheetContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** True while a money action waits for the server: the sheet cannot be dismissed. */
  pending?: boolean;
  closeLabel?: string;
}

/**
 * A panel from the right edge, full screen on a phone. It sits over the page
 * without moving it, so a table behind it keeps its place, and focus returns
 * to the row that opened it.
 */
export function SheetContent({
  className,
  children,
  pending = false,
  closeLabel = 'Close',
  onEscapeKeyDown,
  onInteractOutside,
  ...props
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={OVERLAY} />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        aria-busy={pending || undefined}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
          onEscapeKeyDown?.(event);
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
          onInteractOutside?.(event);
        }}
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface text-text shadow-overlay',
          'sm:inset-y-2 sm:right-2 sm:w-[min(32rem,calc(100%-1rem))] sm:rounded-overlay sm:border sm:border-rule',
          className,
        )}
        {...props}
      >
        {children}
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
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
