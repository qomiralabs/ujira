// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { money, tokenAmount } from '@ujira/core';
import { BrandIcon } from '../../src/icons/brand-icon.js';
import { PayoutCard } from '../../src/payments/payout-card.js';
import { Button } from '../../src/primitives/button.js';

const meta = {
  title: 'Payments/PayoutCard',
  component: PayoutCard,
  args: {
    recipient: 'Wanjiru Kamau',
    amount: money('1250000', 'KES'),
    secondary: tokenAmount('966000000', 'USDC', 'stellar'),
    status: 'paid',
    method: 'USDC to Stellar wallet',
    corridor: 'Kenya',
    timing: { label: 'Paid', value: '4 Nov 2026, 14:02' },
  },
  render: (args) => (
    <div className="max-w-sm">
      <PayoutCard {...args} />
    </div>
  ),
} satisfies Meta<typeof PayoutCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Waiting for approval: the card carries its one action. */
export const WithAction: Story = {
  args: {
    recipient: 'Amara Okafor',
    amount: money('2000000', 'NGN'),
    secondary: tokenAmount('125000000', 'USDC', 'stellar'),
    status: 'pending_approval',
    corridor: 'Nigeria',
    timing: { label: 'Requested', value: '6 Nov 2026, 09:15' },
    action: (
      <Button variant="primary" icon={<BrandIcon name="approval" size={16} />}>
        Review payout
      </Button>
    ),
  },
};

export const Failed: Story = {
  args: {
    recipient: 'Kwame Mensah',
    amount: money('45000', 'GHS'),
    secondary: tokenAmount('385000000', 'USDC', 'stellar'),
    status: 'failed',
    corridor: 'Ghana',
    timing: { label: 'Failed', value: '5 Nov 2026, 18:40' },
  },
};

/** A long name truncates; the amount never does. */
export const LongName: Story = {
  args: {
    recipient: 'Oluwadamilare Adebayo-Ogunleye Chukwuemeka Nwankwo',
    amount: money('99999999999', 'NGN'),
    // At the same 1,600 naira to the dollar as the card with an action.
    secondary: tokenAmount('6249999999375', 'USDC', 'stellar'),
    status: 'delivering',
    corridor: 'Nigeria',
    timing: { label: 'Arrives', value: 'In about 4 minutes' },
  },
};

/** The stacked form of the payouts table on a phone. */
export const List: Story = {
  render: () => (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {(
        [
          ['Wanjiru Kamau', money('1250000', 'KES'), 'paid', 'Kenya'],
          ['Amara Okafor', money('2000000', 'NGN'), 'pending_approval', 'Nigeria'],
          ['Maria Santos', money('1250000', 'PHP'), 'settling', 'Philippines'],
          ['Priya Nair', money('750000', 'INR'), 'blocked', 'India'],
        ] as const
      ).map(([recipient, amount, status, corridor]) => (
        <li key={recipient}>
          <PayoutCard
            recipient={recipient}
            amount={amount}
            status={status}
            method="USDC to Stellar wallet"
            corridor={corridor}
          />
        </li>
      ))}
    </ul>
  ),
};
