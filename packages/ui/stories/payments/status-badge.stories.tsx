// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { BADGE_STATUSES, StatusBadge } from '../../src/payments/status-badge.js';

const meta = {
  title: 'Payments/StatusBadge',
  component: StatusBadge,
  args: { status: 'paid' },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

const GROUPS = [
  [
    'Payout',
    BADGE_STATUSES.filter((status) => !/^(approval_|in_transit|arrived|verified)/.test(status)),
  ],
  ['Approval', ['approval_waiting', 'approval_approved', 'approval_rejected'] as const],
  ['Delivery', ['in_transit', 'arrived', 'verified'] as const],
] as const;

function EveryStatusList() {
  return (
    <div className="flex flex-col gap-5">
      {GROUPS.map(([name, statuses]) => (
        <section key={name} className="flex flex-col gap-2">
          <h3 className="text-body-s font-medium text-text-secondary">{name}</h3>
          <ul className="flex flex-wrap gap-2">
            {statuses.map((status) => (
              <li key={status}>
                <StatusBadge status={status} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Every state, grouped the way the screens show them. */
export const EveryStatus: Story = { render: () => <EveryStatusList /> };

/**
 * The same states with no colour at all. Each one still reads, by its word
 * and its icon, which is the point: status never relies on colour.
 */
export const Greyscale: Story = {
  render: () => (
    <div className="grayscale">
      <EveryStatusList />
    </div>
  ),
};
