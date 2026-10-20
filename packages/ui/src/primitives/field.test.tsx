// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkbox } from './checkbox.js';
import { Field, useFieldControl } from './field.js';
import { Input } from './input.js';
import { RadioGroup, RadioGroupItem } from './radio-group.js';
import { SelectTrigger, SelectValue, Select } from './select.js';
import { Switch } from './switch.js';
import { Textarea } from './textarea.js';

afterEach(cleanup);

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
}

describe('Field', () => {
  it('label, hint and error are linked with aria attributes', () => {
    render(
      <Field
        label="Recipient email"
        hint="We send the receipt here."
        error="Enter an email address."
      >
        <Input type="email" />
      </Field>,
    );
    const input = screen.getByLabelText('Recipient email');
    expect(input.tagName).toBe('INPUT');
    const hint = screen.getByText('We send the receipt here.');
    const error = screen.getByText('Enter an email address.');
    expect(describedBy(input)).toEqual([hint.id, error.closest('[id]')?.id]);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-errormessage')).toBe(error.closest('[id]')?.id);
  });

  it('links only the hint and is not invalid without an error', () => {
    render(
      <Field label="Reference" hint="Shown on the receipt.">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('Reference');
    expect(describedBy(input)).toEqual([screen.getByText('Shown on the receipt.').id]);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-errormessage')).toBe(false);
  });

  it('shows the error with an icon and a word, never colour alone', () => {
    render(
      <Field label="Amount" error="Enter an amount above zero.">
        <Input />
      </Field>,
    );
    const error = screen.getByText('Enter an amount above zero.').closest('[id]');
    expect(error?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(error?.className).toContain('text-blocked');
  });

  it('marks the control required without that word joining its name', () => {
    render(
      <Field label="Mandate name" required>
        <Input />
      </Field>,
    );
    // The marker is for the eye. The meaning reaches assistive technology
    // through aria-required, so a screen reader must not hear the control
    // called "Mandate nameRequired".
    const input = screen.getByRole('textbox', { name: 'Mandate name' });
    expect(input.getAttribute('aria-required')).toBe('true');
    const marker = screen.getByText('Required');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the accessible name clean for every control a field wraps', () => {
    render(
      <>
        <Field label="Note" required>
          <Textarea />
        </Field>
        <Field label="Send a receipt" required>
          <Checkbox />
        </Field>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Note' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Send a receipt' })).toBeTruthy();
  });

  it('keeps an id the caller gave the control', () => {
    render(
      <Field label="Note">
        <Textarea id="payout-note" />
      </Field>,
    );
    expect(screen.getByLabelText('Note').id).toBe('payout-note');
  });

  it('merges a describedby the caller set on the control', () => {
    render(
      <>
        <p id="extra">Extra help</p>
        <Field label="Note" hint="Optional.">
          <Textarea aria-describedby="extra" />
        </Field>
      </>,
    );
    const textarea = screen.getByLabelText('Note');
    expect(describedBy(textarea)).toEqual(['extra', screen.getByText('Optional.').id]);
  });

  it('wires a select trigger, a checkbox and a switch', () => {
    render(
      <>
        <Field label="Corridor" error="Pick a corridor.">
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
          </Select>
        </Field>
        <Field label="Send a receipt" hint="By email.">
          <Checkbox />
        </Field>
        <Field label="Auto approve">
          <Switch />
        </Field>
      </>,
    );
    const select = screen.getByRole('combobox', { name: 'Corridor' });
    expect(select.getAttribute('aria-invalid')).toBe('true');
    const checkbox = screen.getByRole('checkbox', { name: 'Send a receipt' });
    expect(describedBy(checkbox)).toEqual([screen.getByText('By email.').id]);
    expect(screen.getByRole('switch', { name: 'Auto approve' })).toBeTruthy();
  });

  it('names a radio group by its label', () => {
    render(
      <Field label="Payout method" hint="Recipients can change this later." error="Choose one.">
        <RadioGroup>
          <RadioGroupItem value="bank" aria-label="Bank" />
          <RadioGroupItem value="mobile" aria-label="Mobile money" />
        </RadioGroup>
      </Field>,
    );
    const group = screen.getByRole('radiogroup', { name: 'Payout method' });
    expect(describedBy(group)).toHaveLength(2);
    expect(group.getAttribute('aria-invalid')).toBe('true');
  });

  it('returns the props unchanged outside a field', () => {
    let seen: Record<string, unknown> = {};
    function Probe() {
      seen = useFieldControl({ id: 'x', 'aria-describedby': 'y' });
      return null;
    }
    render(<Probe />);
    expect(seen).toEqual({ id: 'x', 'aria-describedby': 'y' });
  });

  it('shows a react-hook-form error and links it to the input', async () => {
    function Form() {
      const { register, handleSubmit, formState } = useForm<{ email: string }>({
        defaultValues: { email: '' },
      });
      return (
        <form onSubmit={(e) => void handleSubmit(() => undefined)(e)}>
          <Field label="Email" error={formState.errors.email?.message}>
            <Input {...register('email', { required: 'Enter an email address.' })} />
          </Field>
          <button type="submit">Save</button>
        </form>
      );
    }
    render(<Form />);
    const input = screen.getByLabelText('Email');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await Promise.resolve();
    });
    const error = await screen.findByText('Enter an email address.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(input)).toContain(error.closest('[id]')?.id);
  });
});
