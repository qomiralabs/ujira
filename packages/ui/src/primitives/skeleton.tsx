// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/**
 * A placeholder shaped like the content that is loading. It is hidden from
 * assistive technology, so mark the region it sits in with aria-busy and give
 * it an accessible name such as "Loading payouts".
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('rounded-control bg-rule motion-safe:animate-pulse', className)}
      {...props}
    />
  );
}
