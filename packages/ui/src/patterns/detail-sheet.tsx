// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../primitives/sheet.js';

export interface DetailSheetProps {
  /** Controlled, so a screen can keep the open item in the URL. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Who or what this is: the recipient, the mandate. */
  title: string;
  /** The amount, as an `<Amount size="hero" />`. It leads the sheet. */
  amount?: ReactNode;
  /** One line under the title, such as the status in words. */
  description?: string;
  children: ReactNode;
  /** The one thing to do here, if there is one. */
  footer?: ReactElement;
  /** True while a money action waits for the server: the sheet cannot be dismissed. */
  pending?: boolean;
}

/**
 * The detail of one row, in a side sheet over the page, so the table behind it
 * keeps its place and its scroll. The amount and the title lead, then the body,
 * then at most one action. Full screen on a phone. Focus returns to the row
 * that opened it.
 */
export function DetailSheet({
  open,
  onOpenChange,
  title,
  amount,
  description,
  children,
  footer,
  pending = false,
}: DetailSheetProps) {
  // A row opens the sheet through state rather than a Radix trigger, so the
  // element that had focus is noted as it opens (layout effects run before
  // the focus scope moves focus inside) and gets it back on close.
  const returnFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) {
      returnFocus.current = document.activeElement;
    }
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        pending={pending}
        onCloseAutoFocus={(event) => {
          const target = returnFocus.current;
          if (target?.isConnected === true) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        <div data-slot="detail-sheet-header" className="flex flex-col gap-1 p-6 pr-14 pb-0">
          <SheetTitle className="text-body font-semibold text-text">{title}</SheetTitle>
          {description === undefined ? null : (
            <SheetDescription className="text-body-s text-text-secondary">
              {description}
            </SheetDescription>
          )}
        </div>
        {amount === undefined ? null : (
          <div data-slot="detail-sheet-amount" className="px-6 pt-3">
            {amount}
          </div>
        )}
        <div data-slot="detail-sheet-body" className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
        {footer === undefined ? null : (
          <div
            data-slot="detail-sheet-footer"
            className="flex justify-end gap-2 border-t border-rule p-4"
          >
            {footer}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
