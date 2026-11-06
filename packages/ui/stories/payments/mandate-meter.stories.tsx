// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { money } from '@ujira/core';
import { MandateMeter } from '../../src/payments/mandate-meter.js';

const meta = {
  title: 'Payments/MandateMeter',
  component: MandateMeter,
  args: {
    budget: money('500000', 'USD'),
    used: money('120000', 'USD'),
    committed: money('30000', 'USD'),
    label: 'Budget this month',
  },
  render: (args) => (
    <div className="max-w-xl">
      <MandateMeter {...args} />
    </div>
  ),
} satisfies Meta<typeof MandateMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** More is held for payouts on their way than is left to spend. */
export const CommittedAboveRemaining: Story = {
  args: { committed: money('300000', 'USD') },
};

/** A mandate with no budget yet draws an empty bar. */
export const ZeroBudget: Story = {
  args: { budget: money('0', 'USD'), used: money('0', 'USD'), committed: money('0', 'USD') },
};

/** Used and committed together past the budget: nothing remains, and the text says by how much. */
export const Overrun: Story = {
  args: { used: money('400000', 'USD'), committed: money('200000', 'USD') },
};

/** In the recipient corridor's currency, with the sign from the second mono face. */
export const Naira: Story = {
  args: {
    budget: money('500000000', 'NGN'),
    used: money('312500000', 'NGN'),
    committed: money('40000000', 'NGN'),
  },
};
