// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Field } from '../src/primitives/field.js';
import { Input } from '../src/primitives/input.js';
import { focusFirst, HOVER } from './helpers.js';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { placeholder: 'name@example.com', type: 'email' },
  render: (args) => (
    <div className="max-w-sm">
      <Field label="Recipient email">
        <Input {...args} />
      </Field>
    </div>
  ),
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Filled: Story = {
  args: { defaultValue: 'amara.okafor@example.com' },
};

export const Hover: Story = { parameters: HOVER };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'amara.okafor@example.com' },
};

export const Invalid: Story = {
  args: { defaultValue: 'amara.okafor@' },
  render: (args) => (
    <div className="max-w-sm">
      <Field label="Recipient email" error="Enter a full email address, like name@example.com.">
        <Input {...args} />
      </Field>
    </div>
  ),
};
