// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { TEXT_CONTROL } from './control-styles.js';
import { useFieldControl } from './field.js';
import { FOCUS_RING } from './focus-ring.js';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  const controlProps = useFieldControl(props);
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        TEXT_CONTROL,
        'flex h-10 cursor-pointer items-center justify-between gap-2 px-3 text-left',
        'data-[placeholder]:text-text-subtle [&>span]:truncate',
        className,
      )}
      {...controlProps}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0 text-text" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          // Overlays are the one place a shadow is allowed.
          'relative z-50 max-h-(--radix-select-content-available-height) min-w-32 overflow-hidden',
          'rounded-control border border-rule bg-surface font-sans text-text shadow-overlay',
          position === 'popper' &&
            'w-full min-w-(--radix-select-trigger-width) data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-text-secondary">
          <ChevronUp aria-hidden="true" strokeWidth={1.5} className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-text-secondary">
          <ChevronDown aria-hidden="true" strokeWidth={1.5} className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2 py-1.5 font-mono text-label text-text-subtle uppercase', className)}
      {...props}
    />
  );
}

export interface SelectItemProps extends ComponentProps<typeof SelectPrimitive.Item> {
  /**
   * One short line saying what this choice is, under the name. It sits
   * outside the item text on purpose: the trigger shows the item text as the
   * chosen value, and a description there would be read back as the value.
   */
  description?: ReactNode;
}

export function SelectItem({ className, children, description, ...props }: SelectItemProps) {
  const generated = useId();
  const descriptionId = description === undefined ? undefined : `${generated}-description`;
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex w-full cursor-pointer flex-col items-start rounded-control py-2 pr-2 pl-8 text-body-s select-none',
        description === undefined && 'h-9 flex-row items-center py-0',
        // bg, not rule: the text tokens are held to 4.5:1 on bg and surface
        // only, and secondary text on the rule ground measures 3.8:1 in dark.
        'data-[highlighted]:bg-bg',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        FOCUS_RING,
        className,
      )}
      {...(descriptionId === undefined ? {} : { 'aria-describedby': descriptionId })}
      {...props}
    >
      <span className="absolute top-2.5 left-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check aria-hidden="true" strokeWidth={1.5} className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {descriptionId === undefined ? null : (
        <span id={descriptionId} className="text-body-s text-text-secondary">
          {description}
        </span>
      )}
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('-mx-1 my-1 h-px bg-rule', className)}
      {...props}
    />
  );
}
