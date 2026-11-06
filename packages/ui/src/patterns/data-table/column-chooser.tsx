// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { Columns3 } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../../lib/cn.js';
import { Checkbox } from '../../primitives/checkbox.js';
import { buttonVariants } from '../../primitives/button.js';

/** Which columns are shown, by column id. A column missing from the map is shown. */
export type ColumnVisibility = Readonly<Record<string, boolean>>;

export interface ColumnChooserProps {
  columns: readonly { id: string; header: string; hideable?: boolean }[];
  visibility: ColumnVisibility;
  onVisibilityChange: (visibility: ColumnVisibility) => void;
  className?: string;
}

/**
 * Shows or hides table columns. A disclosure with one checkbox per column the
 * person may hide; it only reports the new map, and the caller owns it.
 */
export function ColumnChooser({
  columns,
  visibility,
  onVisibilityChange,
  className,
}: ColumnChooserProps) {
  const id = useId();
  const hideable = columns.filter((column) => column.hideable !== false);
  return (
    <details data-slot="column-chooser" className={cn('relative', className)}>
      <summary
        className={cn(
          buttonVariants({ variant: 'secondary', size: 'sm' }),
          'cursor-pointer list-none [&::-webkit-details-marker]:hidden',
        )}
      >
        <Columns3 aria-hidden="true" strokeWidth={1.5} className="size-4" />
        Columns
      </summary>
      <fieldset
        aria-labelledby={`${id}-legend`}
        className="absolute end-0 z-20 mt-2 flex min-w-48 flex-col gap-2 rounded-overlay border border-rule bg-surface p-3 shadow-overlay"
      >
        <legend id={`${id}-legend`} className="sr-only">
          Columns to show
        </legend>
        {hideable.map((column) => {
          const checkboxId = `${id}-${column.id}`;
          return (
            <div key={column.id} className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={visibility[column.id] !== false}
                onCheckedChange={(checked) => {
                  onVisibilityChange({ ...visibility, [column.id]: checked === true });
                }}
              />
              <label htmlFor={checkboxId} className="cursor-pointer text-body-s text-text">
                {column.header}
              </label>
            </div>
          );
        })}
      </fieldset>
    </details>
  );
}
