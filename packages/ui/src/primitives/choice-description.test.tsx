// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field } from './field.js';
import { RadioGroup, RadioGroupItem } from './radio-group.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';

afterEach(cleanup);

function describedText(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

describe('RadioGroupItem description', () => {
  it('links a description to the control it belongs to', () => {
    render(
      <RadioGroup defaultValue="mobile">
        <RadioGroupItem
          value="mobile"
          label="Mobile money"
          description="Paid into their mobile money wallet, usually within minutes."
        />
        <RadioGroupItem
          value="cash"
          label="Cash pickup"
          description="Collected in person with an ID."
        />
      </RadioGroup>,
    );
    const mobile = screen.getByRole('radio', { name: 'Mobile money' });
    expect(describedText(mobile)).toBe(
      'Paid into their mobile money wallet, usually within minutes.',
    );
    const cash = screen.getByRole('radio', { name: 'Cash pickup' });
    expect(describedText(cash)).toBe('Collected in person with an ID.');
  });

  it('names the control by its label, so the description never becomes the name', () => {
    render(
      <RadioGroup>
        <RadioGroupItem value="bank" label="Bank account" description="Paid by bank transfer." />
      </RadioGroup>,
    );
    const radio = screen.getByRole('radio', { name: 'Bank account' });
    expect(radio.getAttribute('aria-label')).toBeNull();
    expect(radio.textContent).not.toContain('Paid by bank transfer.');
  });

  it('clicking the label or the description chooses the option', () => {
    render(
      <RadioGroup>
        <RadioGroupItem value="bank" label="Bank account" description="Paid by bank transfer." />
      </RadioGroup>,
    );
    const radio = screen.getByRole('radio', { name: 'Bank account' });
    const label = screen.getByText('Bank account');
    expect(label.getAttribute('for')).toBe(radio.id);
  });

  it('takes a label with no description, for choices the principal named', () => {
    render(
      <RadioGroup>
        <RadioGroupItem value="annotation" label="Annotation team" />
      </RadioGroup>,
    );
    const radio = screen.getByRole('radio', { name: 'Annotation team' });
    expect(radio.hasAttribute('aria-describedby')).toBe(false);
  });

  it('still renders a bare control when a screen lays the row out itself', () => {
    render(
      <RadioGroup>
        <RadioGroupItem value="bank" aria-label="Bank account" />
      </RadioGroup>,
    );
    const radio = screen.getByRole('radio', { name: 'Bank account' });
    expect(radio.getAttribute('data-slot')).toBe('radio-group-item');
  });

  it('keeps the field error linked alongside its own description', () => {
    render(
      <Field label="Payout method" error="Choose how the recipient is paid.">
        <RadioGroup>
          <RadioGroupItem value="bank" label="Bank account" description="Paid by bank transfer." />
        </RadioGroup>
      </Field>,
    );
    const group = screen.getByRole('radiogroup', { name: 'Payout method' });
    expect(describedText(group)).toContain('Choose how the recipient is paid.');
    const radio = screen.getByRole('radio', { name: 'Bank account' });
    expect(describedText(radio)).toContain('Paid by bank transfer.');
  });
});

describe('SelectItem description', () => {
  it('links a description to the option without putting it in the chosen value', () => {
    render(
      <Select defaultValue="mobile" open>
        <SelectTrigger>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="mobile" description="Usually within minutes.">
            Mobile money
          </SelectItem>
          <SelectItem value="cash" description="Collected in person with an ID.">
            Cash pickup
          </SelectItem>
        </SelectContent>
      </Select>,
    );
    const option = screen.getByRole('option', { name: /Mobile money/ });
    expect(describedText(option)).toBe('Usually within minutes.');
  });

  it('shows the name alone as the chosen value, never the description', () => {
    // The open list hides the trigger from assistive technology, so the
    // chosen value is read back on the closed control.
    render(
      <Select defaultValue="mobile">
        <SelectTrigger>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="mobile" description="Usually within minutes.">
            Mobile money
          </SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain('Mobile money');
    expect(trigger.textContent).not.toContain('Usually within minutes.');
  });

  it('takes an option with no description', () => {
    render(
      <Select open>
        <SelectTrigger>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="annotation">Annotation team</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(
      screen.getByRole('option', { name: 'Annotation team' }).hasAttribute('aria-describedby'),
    ).toBe(false);
  });
});
