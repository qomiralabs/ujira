// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { money } from '@ujira/core';
import { useState } from 'react';
import { BrandIcon } from '../../src/icons/brand-icon.js';
import { Amount } from '../../src/money/amount.js';
import { DetailSheet } from '../../src/patterns/detail-sheet.js';
import { StatusBadge } from '../../src/payments/status-badge.js';
import { Button } from '../../src/primitives/button.js';

const PEOPLE = Array.from({ length: 40 }, (_, index) => `Recipient ${String(index + 1)}`);

/** A long list of rows: open one far down, close it, and the page is where it was. */
function PayoutsWithSheet({ initiallyOpen }: { initiallyOpen?: string }) {
  const [open, setOpen] = useState<string | undefined>(initiallyOpen);
  return (
    <div className="flex max-w-xl flex-col gap-2">
      {PEOPLE.map((name) => (
        <button
          key={name}
          type="button"
          data-row={name}
          className="flex h-11 items-center justify-between rounded-control border border-rule bg-surface px-3 text-start text-body-s text-text"
          onClick={() => {
            setOpen(name);
          }}
        >
          {name}
          <Amount minor="2000000" currency="NGN" size="data" />
        </button>
      ))}
      <DetailSheet
        open={open !== undefined}
        onOpenChange={(next) => {
          if (!next) setOpen(undefined);
        }}
        title={open ?? ''}
        description="Waiting for approval since 09:15"
        amount={<Amount value={money('2000000', 'NGN')} size="hero" />}
        footer={
          <Button variant="primary" icon={<BrandIcon name="approval" size={16} />}>
            Approve payout
          </Button>
        }
      >
        <div className="flex flex-col items-start gap-3 text-body-s text-text-secondary">
          <StatusBadge status="pending_approval" />
          <p>The timeline, the receipt and the mandate rule that allowed it go here.</p>
        </div>
      </DetailSheet>
    </div>
  );
}

const meta = {
  title: 'Patterns/DetailSheet',
  component: PayoutsWithSheet,
} satisfies Meta<typeof PayoutsWithSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Open: Story = { args: { initiallyOpen: 'Recipient 1' } };
