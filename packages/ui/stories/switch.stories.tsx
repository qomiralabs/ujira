// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Field } from '../src/primitives/field.js';
import { Switch } from '../src/primitives/switch.js';
import { focusFirst, HOVER } from './helpers.js';

const meta = {
  title: 'Primitives/Switch',
  component: Switch,
  render: (args) => (
    <div className="max-w-sm">
      <Field label="Approve payouts under the mandate cap automatically">
        <Switch {...args} />
      </Field>
    </div>
  ),
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = { args: { defaultChecked: true } };

export const Hover: Story = { parameters: HOVER };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = { args: { disabled: true, defaultChecked: true } };

export const Invalid: Story = {
  render: (args) => (
    <div className="max-w-sm">
      <Field
        label="Approve payouts under the mandate cap automatically"
        error="Set a mandate cap before you turn this on."
      >
        <Switch {...args} />
      </Field>
    </div>
  ),
};
