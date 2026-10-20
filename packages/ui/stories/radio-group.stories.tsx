// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { Field } from '../src/primitives/field.js';
import { Label } from '../src/primitives/label.js';
import { RadioGroup, RadioGroupItem } from '../src/primitives/radio-group.js';
import { focusFirst, HOVER } from './helpers.js';

const METHODS = [
  { value: 'mobile', label: 'Mobile money' },
  { value: 'bank', label: 'Bank account' },
  { value: 'cash', label: 'Cash pickup' },
  { value: 'wallet', label: 'USDC to a Stellar wallet' },
] as const;

interface Args extends ComponentProps<typeof RadioGroup> {
  error?: string;
}

function MethodPicker({ error, ...args }: Args) {
  return (
    <div className="max-w-sm">
      <Field label="Payout method" hint="The recipient can change this later." error={error}>
        <RadioGroup {...args}>
          {METHODS.map(({ value, label }) => (
            <div key={value} className="flex items-center gap-3">
              <RadioGroupItem value={value} id={`method-${value}`} />
              <Label htmlFor={`method-${value}`}>{label}</Label>
            </div>
          ))}
        </RadioGroup>
      </Field>
    </div>
  );
}

const meta = {
  title: 'Primitives/RadioGroup',
  component: MethodPicker,
  args: { defaultValue: 'mobile' },
} satisfies Meta<typeof MethodPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Hover: Story = { parameters: HOVER };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = { args: { disabled: true } };

export const Invalid: Story = {
  args: { defaultValue: '', error: 'Choose how the recipient is paid.' },
};
