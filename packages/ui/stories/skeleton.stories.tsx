// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Skeleton } from '../src/primitives/skeleton.js';

const meta = {
  title: 'Primitives/Skeleton',
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A payout row while it loads: the shapes match the row that replaces them. */
export const Default: Story = {
  render: (args) => (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading payouts"
      className="flex max-w-lg items-center gap-4 rounded-card border border-rule bg-surface p-4"
    >
      <Skeleton className="size-10 rounded-full" {...args} />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-2/5" {...args} />
        <Skeleton className="h-3 w-1/4" {...args} />
      </div>
      <Skeleton className="h-5 w-24" {...args} />
    </div>
  ),
};
