// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { BrandIcon } from '../../src/icons/brand-icon.js';
import { EmptyState } from '../../src/patterns/empty-state.js';
import { Button } from '../../src/primitives/button.js';

const meta = {
  title: 'Patterns/EmptyState',
  component: EmptyState,
  args: {
    variant: 'nothing-yet',
    icon: 'payout',
    title: 'No payouts yet',
    message: 'Payouts show here the moment a mandate requests one. Set one up to start.',
    action: (
      <Button variant="primary" icon={<BrandIcon name="mandate" size={16} />}>
        Set up a mandate
      </Button>
    ),
  },
  render: (args) => (
    <div className="max-w-2xl">
      <EmptyState {...args} />
    </div>
  ),
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NothingYet: Story = {};

/** Things exist, but the filters hide every one. The action widens them. */
export const NoResults: Story = {
  args: {
    variant: 'no-results',
    title: 'No payouts match these filters',
    message: 'Nothing in Kenya was paid between 1 and 7 November.',
    action: <Button>Clear the filters</Button>,
  },
};

/** Without a heading, for a small panel. The sentence names the region. */
export const WithoutTitle: Story = {
  args: {
    icon: 'receipt',
    message: 'Receipts appear once a payout is paid.',
    action: <Button>Open payouts</Button>,
  },
};
