// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Field } from '../src/primitives/field.js';
import { Input } from '../src/primitives/input.js';
import { focusFirst, HOVER } from './helpers.js';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { placeholder: 'name@example.com', type: 'email' },
  render: (args) => (
    <div className="max-w-sm">
      <Field label="Recipient email">
        <Input {...args} />
      </Field>
    </div>
  ),
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Filled: Story = {
  args: { defaultValue: 'amara.okafor@example.com' },
};

export const Hover: Story = { parameters: HOVER };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'amara.okafor@example.com' },
};

/**
 * An amount: JetBrains Mono, tabular, right aligned, the recipient's own
 * currency first with its symbol and two decimals. The shared money formatter
 * produces the string from integer minor units; the input never does its own
 * arithmetic.
 */
export const Amount: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-5">
      <Field label="Amount" hint="What the recipient is paid, in their own currency.">
        <Input
          inputMode="decimal"
          defaultValue="1,500.00"
          className="text-right font-mono tabular-nums"
        />
      </Field>
      <div className="flex flex-col gap-1">
        <span className="text-body-s text-text-secondary">They receive</span>
        {/* The amount is the hero, so it never wraps and never shrinks. */}
        <span className="font-mono text-amount-xl tabular-nums whitespace-nowrap text-text">
          KSh 1,500.00
        </span>
      </div>
    </div>
  ),
};

/**
 * A principal whose corridors hold more than one dollar currency sees the ISO
 * code on every dollar amount, so 96 US dollars is never read as 96 Canadian.
 * Whether a view needs codes is decided by the principal's corridors and
 * passed to the shared formatter, never chosen screen by screen.
 */
export const AmountInAPrincipalView: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-3">
      {[
        ['Annotation batch 14', '$96.00 USD'],
        ['Design review', '$1,500.00 CAD'],
        ['Bounty payout', '$240.00 USD'],
      ].map(([label, amount]) => (
        <div key={label} className="flex items-baseline justify-between gap-4">
          <span className="text-body-s text-text-secondary">{label}</span>
          <span className="font-mono text-data tabular-nums text-text">{amount}</span>
        </div>
      ))}
    </div>
  ),
};

export const Invalid: Story = {
  args: { defaultValue: 'amara.okafor@' },
  render: (args) => (
    <div className="max-w-sm">
      <Field label="Recipient email" error="Enter a full email address, like name@example.com.">
        <Input {...args} />
      </Field>
    </div>
  ),
};
