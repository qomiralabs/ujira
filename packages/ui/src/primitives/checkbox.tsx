// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { useFieldControl } from './field.js';
import { FOCUS_RING } from './focus-ring.js';

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  const controlProps = useFieldControl(props);
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer relative inline-flex size-5 shrink-0 cursor-pointer items-center justify-center',
        'rounded-control border border-text-subtle bg-surface text-surface',
        // The box stays 20px, but the target is 24px, so it still meets WCAG
        // 2.2 AA in a dense table row with no label to click beside it.
        'before:absolute before:top-1/2 before:left-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2',
        'transition-[color,background-color,border-color] duration-150 ease-out motion-reduce:transition-none',
        'hover:border-text',
        'data-[state=checked]:border-text data-[state=checked]:bg-text',
        'data-[state=indeterminate]:border-text data-[state=indeterminate]:bg-text',
        'aria-invalid:border-blocked',
        'disabled:cursor-not-allowed disabled:opacity-50',
        FOCUS_RING,
        className,
      )}
      {...controlProps}
    >
      <CheckboxPrimitive.Indicator className="group flex items-center justify-center">
        <Check
          aria-hidden="true"
          strokeWidth={1.5}
          className="size-4 group-data-[state=indeterminate]:hidden"
        />
        <Minus
          aria-hidden="true"
          strokeWidth={1.5}
          className="hidden size-4 group-data-[state=indeterminate]:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
