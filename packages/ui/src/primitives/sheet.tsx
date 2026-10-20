// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';
import { DialogOverlay } from './dialog.js';
import { OVERLAY_PANEL } from './overlay-styles.js';
import { pendingLock } from './use-pending-lock.js';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export type SheetSide = 'right' | 'left' | 'bottom';

// A detail sheet slides in from the edge it is anchored to, so the table
// behind it keeps its place. Money moves left to right, so a detail opened
// from a row comes from the right.
const SIDES: Record<SheetSide, string> = {
  right:
    'inset-y-0 right-0 h-full w-[calc(100vw-2rem)] max-w-md rounded-l-overlay border-y-0 border-r-0 data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
  left: 'inset-y-0 left-0 h-full w-[calc(100vw-2rem)] max-w-md rounded-r-overlay border-y-0 border-l-0 data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  bottom:
    'inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-overlay border-x-0 border-b-0 data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
};

export interface SheetContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  side?: SheetSide;
  /** A money action is waiting for the server. See DialogContent. */
  pending?: boolean;
}

export function SheetContent({
  className,
  children,
  side = 'right',
  pending = false,
  ...props
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          OVERLAY_PANEL,
          'gap-0 overflow-y-auto p-6',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          SIDES[side],
          className,
        )}
        {...pendingLock(pending)}
        {...props}
      >
        {children}
        {pending ? null : (
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close"
              className="absolute top-3 right-3 size-8"
            >
              <X aria-hidden="true" strokeWidth={1.5} />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 pr-8 pb-4', className)}
      {...props}
    />
  );
}

export function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'mt-auto flex flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-title text-text', className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-body-s text-text-secondary', className)}
      {...props}
    />
  );
}
