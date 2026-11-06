// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { money } from '@ujira/core';
import { KpiCard } from '../../src/patterns/kpi-card.js';
import { Button } from '../../src/primitives/button.js';

const meta = {
  title: 'Patterns/KpiCard',
  component: KpiCard,
  args: {
    title: 'Paid this week',
    value: { amount: money('12550075', 'USD') },
    period: '1 to 7 Nov',
    delta: { change: 'up', percent: '12', comparedWith: 'last week' },
  },
  render: (args) => (
    <div className="max-w-xs">
      <KpiCard {...args} />
    </div>
  ),
} satisfies Meta<typeof KpiCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The four overview measures side by side, as the overview lays them out. */
export const Overview: Story = {
  render: () => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        title="Paid this week"
        value={{ amount: money('12550075', 'USD') }}
        period="1 to 7 Nov"
        delta={{ change: 'up', percent: '12', comparedWith: 'last week' }}
      />
      <KpiCard
        title="Payouts completed"
        value={{ count: 1284 }}
        period="1 to 7 Nov"
        delta={{ change: 'down', percent: '3.5', comparedWith: 'last week' }}
      />
      <KpiCard
        title="Median time to paid"
        value={{ text: '4 min' }}
        period="1 to 7 Nov"
        delta={{ change: 'none', comparedWith: 'last week' }}
      />
      <KpiCard
        title="Blocked by policy"
        value={{ count: 3 }}
        period="1 to 7 Nov"
        action={<Button size="sm">Review blocked payouts</Button>}
      />
    </div>
  ),
};

/** The slot the trend chart fills once the chart wrapper lands. */
export const WithSparklineSlot: Story = {
  args: {
    sparkline: <div className="h-full rounded-control border border-dashed border-rule" />,
  },
};
