// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { TEXT_CONTROL } from './control-styles.js';
import { useFieldControl } from './field.js';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  const controlProps = useFieldControl(props);
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(TEXT_CONTROL, 'h-10 px-3', className)}
      {...controlProps}
    />
  );
}
