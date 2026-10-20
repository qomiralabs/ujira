// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { Button } from '../src/primitives/button.js';
import { Separator } from '../src/primitives/separator.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  type SheetSide,
} from '../src/primitives/sheet.js';
import { focusFirst } from './helpers.js';

interface Args extends ComponentProps<typeof Sheet> {
  side?: SheetSide;
  pending?: boolean;
}

const ROWS = [
  ['Recipient', 'Amara Okafor'],
  ['Method', 'Mobile money, M-Pesa'],
  ['Corridor', 'Kenya'],
  ['Mandate', 'Annotation team, October'],
  ['Requested', '20 Oct 2026, 09:12'],
] as const;

function PayoutDetail({ side = 'right', pending = false, ...args }: Args) {
  return (
    <Sheet open {...args}>
      <SheetContent side={side} pending={pending}>
        <SheetHeader>
          <SheetTitle>KSh 1,500.00</SheetTitle>
          <SheetDescription>Paid to Amara Okafor, 20 Oct 2026.</SheetDescription>
        </SheetHeader>
        <Separator />
        <dl className="flex flex-col gap-3 py-4">
          {ROWS.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <dt className="text-body-s text-text-secondary">{label}</dt>
              <dd className="text-right font-mono text-data text-text">{value}</dd>
            </div>
          ))}
        </dl>
        <SheetFooter>
          <Button variant="ghost" disabled={pending}>
            Download receipt
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

const meta = {
  title: 'Primitives/Sheet',
  component: PayoutDetail,
  argTypes: { side: { control: 'inline-radio', options: ['right', 'left', 'bottom'] } },
} satisfies Meta<typeof PayoutDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A payout detail opens from the right, so the table behind keeps its place. */
export const Default: Story = {};

export const Left: Story = { args: { side: 'left' } };

export const Bottom: Story = { args: { side: 'bottom' } };

export const Focus: Story = { play: focusFirst };

export const Pending: Story = { args: { pending: true } };
