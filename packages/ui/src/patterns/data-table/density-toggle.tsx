// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { useId } from 'react';
import { cn } from '../../lib/cn.js';
import { Switch } from '../../primitives/switch.js';

/** Row height: 44px by default, 36px when compact. */
export type Density = 'comfortable' | 'compact';

export interface DensityToggleProps {
  density: Density;
  onDensityChange: (density: Density) => void;
  className?: string;
}

/** A switch for compact rows. It only reports; the caller owns the state, for example in the URL. */
export function DensityToggle({ density, onDensityChange, className }: DensityToggleProps) {
  const id = useId();
  return (
    <div data-slot="density-toggle" className={cn('flex items-center gap-2', className)}>
      <Switch
        id={id}
        checked={density === 'compact'}
        onCheckedChange={(checked) => {
          onDensityChange(checked ? 'compact' : 'comfortable');
        }}
      />
      <label htmlFor={id} className="cursor-pointer text-body-s text-text">
        Compact rows
      </label>
    </div>
  );
}
