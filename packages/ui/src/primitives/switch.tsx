// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { useFieldControl } from './field.js';
import { FOCUS_RING } from './focus-ring.js';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  const controlProps = useFieldControl(props);
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full',
        'border border-text-subtle bg-surface',
        'transition-[color,background-color,border-color] duration-150 ease-out motion-reduce:transition-none',
        'hover:border-text data-[state=checked]:border-text data-[state=checked]:bg-text',
        'aria-invalid:border-blocked',
        'disabled:cursor-not-allowed disabled:opacity-50',
        FOCUS_RING,
        className,
      )}
      {...controlProps}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-text-subtle',
          'translate-x-0.75 transition-transform duration-150 ease-out motion-reduce:transition-none',
          'data-[state=checked]:translate-x-4.75 data-[state=checked]:bg-surface',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
