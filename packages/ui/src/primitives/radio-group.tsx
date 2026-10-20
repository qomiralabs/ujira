// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { useFieldControl } from './field.js';
import { FOCUS_RING } from './focus-ring.js';

export function RadioGroup({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  const controlProps = useFieldControl(props, { group: true });
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('group/radio grid gap-3', className)}
      {...controlProps}
    />
  );
}

export function RadioGroupItem({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'peer inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full',
        'border border-text-subtle bg-surface',
        'transition-[color,background-color,border-color] duration-150 ease-out motion-reduce:transition-none',
        'hover:border-text data-[state=checked]:border-text',
        'group-aria-invalid/radio:border-blocked aria-invalid:border-blocked',
        'disabled:cursor-not-allowed disabled:opacity-50',
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2.5 rounded-full bg-text" />
    </RadioGroupPrimitive.Item>
  );
}
