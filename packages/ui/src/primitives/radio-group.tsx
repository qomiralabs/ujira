// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { useFieldControl } from './field.js';
import { FOCUS_RING } from './focus-ring.js';
import { Label } from './label.js';

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

export interface RadioGroupItemProps extends ComponentProps<typeof RadioGroupPrimitive.Item> {
  /**
   * The name of the choice. Pass it and the item lays its own row out, with
   * the label beside the control and the description under it.
   */
  label?: ReactNode;
  /**
   * One short line saying what this choice is, linked to the control with
   * aria-describedby. Use it wherever the product named the choice and the
   * name alone does not say what happens, which is every payout method.
   * Leave it out for things the principal named themselves, such as a
   * project or a mandate, where the name is the whole content.
   */
  description?: ReactNode;
}

export function RadioGroupItem({
  className,
  label,
  description,
  id,
  ...props
}: RadioGroupItemProps) {
  const generated = useId();
  const controlId = id ?? `${generated}-radio`;
  const descriptionId = description === undefined ? undefined : `${generated}-description`;
  const control = (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      id={controlId}
      className={cn(
        'peer relative inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full',
        'border border-text-subtle bg-surface',
        // The box stays 20px, but the target is 24px, so it still meets
        // WCAG 2.2 AA in a dense row with no label to click beside it.
        'before:absolute before:top-1/2 before:left-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2',
        'transition-[color,background-color,border-color] duration-150 ease-out motion-reduce:transition-none',
        'hover:border-text data-[state=checked]:border-text',
        'group-aria-invalid/radio:border-blocked aria-invalid:border-blocked',
        'disabled:cursor-not-allowed disabled:opacity-50',
        FOCUS_RING,
        label === undefined && className,
      )}
      {...(descriptionId === undefined ? {} : { 'aria-describedby': descriptionId })}
      {...props}
    >
      {/*
       * Off the 4px grid on purpose: a 10px dot leaves an even 4px ring of
       * ground inside the 20px circle. 8px reads hollow, 12px reads filled.
       */}
      <RadioGroupPrimitive.Indicator className="size-2.5 rounded-full bg-text" />
    </RadioGroupPrimitive.Item>
  );
  if (label === undefined) return control;
  return (
    <div className={cn('flex items-start gap-3', className)}>
      {control}
      <div className="flex flex-col gap-1">
        <Label htmlFor={controlId}>{label}</Label>
        {descriptionId === undefined ? null : (
          <p id={descriptionId} className="text-body-s text-text-secondary">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
