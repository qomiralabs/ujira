// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Separator } from '../src/primitives/separator.js';

const meta = {
  title: 'Primitives/Separator',
  component: Separator,
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="max-w-sm text-body-s">
      <p className="text-text">Mandate</p>
      <p className="text-text-secondary">Annotation team, October</p>
      <Separator className="my-4" {...args} />
      <p className="text-text">Approver</p>
      <p className="text-text-secondary">Wanjiru Kamau</p>
    </div>
  ),
};

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => (
    <div className="flex h-6 items-center gap-4 text-body-s text-text">
      <span>Payouts</span>
      <Separator {...args} />
      <span>Receipts</span>
      <Separator {...args} />
      <span>Mandates</span>
    </div>
  ),
};
