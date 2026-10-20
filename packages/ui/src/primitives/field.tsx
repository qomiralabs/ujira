// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { CircleAlert } from 'lucide-react';
import {
  createContext,
  isValidElement,
  useContext,
  useId,
  type AriaAttributes,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn.js';
import { Label } from './label.js';

interface FieldContextValue {
  controlId: string;
  labelId: string;
  hintId: string | undefined;
  errorId: string | undefined;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** The accessibility props a form control takes from the field around it. */
export interface FieldControlProps {
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-invalid'?: AriaAttributes['aria-invalid'] | undefined;
  'aria-errormessage'?: string | undefined;
  'aria-required'?: AriaAttributes['aria-required'] | undefined;
}

/**
 * Merges the field's id and its label, hint and error links into a control's
 * props. Outside a field the props come back unchanged. Group controls such
 * as a radio group are named by the label with aria-labelledby.
 */
export function useFieldControl<P extends FieldControlProps>(
  props: P,
  options: { group?: boolean } = {},
): P {
  const field = useContext(FieldContext);
  if (field === null) return props;
  const describedBy = [props['aria-describedby'], field.hintId, field.errorId]
    .filter((id): id is string => typeof id === 'string' && id !== '')
    .join(' ');
  const merged: P = { ...props, id: props.id ?? field.controlId };
  if (describedBy !== '') merged['aria-describedby'] = describedBy;
  if (options.group === true) merged['aria-labelledby'] = props['aria-labelledby'] ?? field.labelId;
  if (field.errorId !== undefined) {
    merged['aria-invalid'] = true;
    merged['aria-errormessage'] = field.errorId;
  }
  if (field.required) merged['aria-required'] = true;
  return merged;
}

export interface FieldProps extends Omit<ComponentProps<'div'>, 'children'> {
  /** What the control asks for, in sentence case. */
  label: ReactNode;
  /** One line of help shown under the control. */
  hint?: ReactNode;
  /**
   * What is wrong and how to fix it. Pass the react-hook-form message, for
   * example `formState.errors.email?.message`; the field turns invalid while
   * it is set.
   */
  error?: ReactNode;
  required?: boolean;
  /** One form control: Input, Textarea, Select, Checkbox, Switch or RadioGroup. */
  children: ReactNode;
}

function childId(children: ReactNode): string | undefined {
  if (!isValidElement<{ id?: unknown }>(children)) return undefined;
  const id = children.props.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** A label, one control, an optional hint and an error, linked for assistive technology. */
export function Field({
  label,
  hint,
  error,
  required = false,
  className,
  children,
  ...props
}: FieldProps) {
  const base = useId();
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const value: FieldContextValue = {
    controlId: childId(children) ?? `${base}-control`,
    labelId: `${base}-label`,
    hintId: hint === undefined ? undefined : `${base}-hint`,
    errorId: hasError ? `${base}-error` : undefined,
    required,
  };
  return (
    <FieldContext value={value}>
      <div data-slot="field" className={cn('flex flex-col gap-1.5', className)} {...props}>
        <Label id={value.labelId} htmlFor={value.controlId}>
          {label}
          {required ? (
            <span className="ml-2 font-mono text-label text-text-subtle uppercase">Required</span>
          ) : null}
        </Label>
        {children}
        {value.hintId === undefined ? null : (
          <p id={value.hintId} className="text-body-s text-text-secondary">
            {hint}
          </p>
        )}
        {value.errorId === undefined ? null : (
          <p id={value.errorId} className="flex items-start gap-1.5 text-body-s text-blocked">
            <CircleAlert aria-hidden="true" strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </FieldContext>
  );
}
