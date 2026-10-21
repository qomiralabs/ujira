// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { TEXT_CONTROL } from './control-styles.js';
import { useFieldControl } from './field.js';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  const controlProps = useFieldControl(props);
  return (
    <textarea
      data-slot="textarea"
      className={cn(TEXT_CONTROL, 'min-h-24 resize-y px-3 py-2', className)}
      {...controlProps}
    />
  );
}
