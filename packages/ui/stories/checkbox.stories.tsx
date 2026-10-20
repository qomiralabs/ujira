// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox } from '../src/primitives/checkbox.js';
import { Field } from '../src/primitives/field.js';
import { Label } from '../src/primitives/label.js';
import { focusFirst, HOVER } from './helpers.js';

const meta = {
  title: 'Primitives/Checkbox',
  component: Checkbox,
  render: (args) => (
    <div className="flex items-center gap-3">
      <Checkbox id="receipt-email" {...args} />
      <Label htmlFor="receipt-email">Email the receipt to the recipient</Label>
    </div>
  ),
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = { args: { defaultChecked: true } };

export const Indeterminate: Story = {
  args: { checked: 'indeterminate' },
  render: (args) => (
    <div className="flex items-center gap-3">
      <Checkbox id="select-all" {...args} />
      <Label htmlFor="select-all">Select all payouts on this page</Label>
    </div>
  ),
};

export const Hover: Story = { parameters: HOVER };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = {
  args: { disabled: true, defaultChecked: true },
};

export const Invalid: Story = {
  render: (args) => (
    <div className="max-w-md">
      <Field
        label="I have checked the amount and the recipient"
        error="Confirm the details before you approve."
      >
        <Checkbox {...args} />
      </Field>
    </div>
  ),
};
