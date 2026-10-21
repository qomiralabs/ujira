// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input } from '../src/primitives/input.js';
import { Label } from '../src/primitives/label.js';

const meta = {
  title: 'Primitives/Label',
  component: Label,
  args: { children: 'Mandate name' },
  render: (args) => (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor="mandate-name" {...args} />
      <Input id="mandate-name" defaultValue="Annotation team, October" />
    </div>
  ),
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  render: (args) => (
    <div className="flex max-w-sm items-center gap-3">
      <Input id="mandate-cap" disabled defaultValue="Locked" className="peer order-2" />
      <Label htmlFor="mandate-cap" className="order-1 shrink-0" {...args}>
        Monthly cap
      </Label>
    </div>
  ),
};
