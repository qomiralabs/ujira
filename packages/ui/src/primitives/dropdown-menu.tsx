// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { FOCUS_RING } from './focus-ring.js';
import { OVERLAY_PANEL } from './overlay-styles.js';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;
export const DropdownMenuSub = MenuPrimitive.Sub;

function InPlace({ children }: { children: ReactNode }) {
  return children;
}

// Every row in a menu: one height, one highlight, one disabled treatment.
const ITEM = [
  'relative flex h-9 cursor-default items-center gap-2.5 rounded-control px-2.5 select-none',
  'text-body-s outline-none',
  'data-[highlighted]:bg-bg',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
  '[&_svg]:size-4 [&_svg]:shrink-0',
].join(' ');

export interface DropdownMenuContentProps extends ComponentProps<typeof MenuPrimitive.Content> {
  /**
   * Render the menu where it sits instead of in a portal. Needed inside a
   * modal dialog or sheet, which make everything outside themselves inert: a
   * portalled menu would open outside and could not be used.
   */
  inline?: boolean;
}

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 12,
  inline = false,
  ...props
}: DropdownMenuContentProps) {
  const Portal = inline ? InPlace : MenuPrimitive.Portal;
  return (
    <Portal>
      <MenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          OVERLAY_PANEL,
          // Positioned by Radix, so it is not fixed to the viewport.
          'static gap-0',
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-48 overflow-y-auto',
          // Offered, not imposed: a panel such as a project switcher can set
          // w-(--radix-dropdown-menu-trigger-width) to match its trigger.
          'max-w-[calc(100vw-1.5rem)] rounded-overlay p-1.5',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      />
    </Portal>
  );
}

export interface DropdownMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  /** Pause, revoke, delete. Always pair it with a confirmation. */
  variant?: 'default' | 'danger';
  /** Leaves room for the check column, so rows line up with checkable ones. */
  inset?: boolean;
}

export function DropdownMenuItem({
  className,
  variant = 'default',
  inset = false,
  ...props
}: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        ITEM,
        variant === 'danger' ? 'text-blocked' : 'text-text',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(ITEM, 'pl-8 text-text', className)}
      {...props}
    >
      <span className="absolute left-2.5 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" strokeWidth={1.5} />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        ITEM,
        // The chosen row carries a raised ground as well as the marker, so
        // the choice never rests on an icon alone. The marker is the brand
        // stroke in the text colour: saffron is for the mark, the amount, the
        // one primary action and the focus ring, and a selection is none of
        // those.
        'pl-8 text-text-secondary data-[state=checked]:bg-bg data-[state=checked]:text-text',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2.5 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" strokeWidth={1.5} />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn(
        'px-2.5 pt-1.5 pb-2 font-mono text-label text-text-secondary uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-1.5 my-1.5 h-px bg-rule', className)}
      {...props}
    />
  );
}

/** A keyboard shortcut, set in the mono face like every other code label. */
export function DropdownMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto font-mono text-label text-text-subtle', className)}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return (
    <MenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(ITEM, 'text-text data-[state=open]:bg-bg', className)}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" strokeWidth={1.5} className="ml-auto" />
    </MenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        className={cn(
          OVERLAY_PANEL,
          'static z-50 min-w-40 gap-0 rounded-overlay p-1.5',
          FOCUS_RING,
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}
