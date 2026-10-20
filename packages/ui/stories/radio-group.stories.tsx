// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { Field } from '../src/primitives/field.js';
import { RadioGroup, RadioGroupItem } from '../src/primitives/radio-group.js';
import { focusFirst, HOVER } from './helpers.js';

// Every choice the product named carries one line saying what it is. A
// recipient choosing how they are paid should never have to guess.
const METHODS = [
  {
    value: 'mobile',
    label: 'Mobile money',
    description: 'Paid into their mobile money wallet, usually within minutes.',
  },
  {
    value: 'bank',
    label: 'Bank account',
    description: 'Paid by bank transfer, usually the next working day.',
  },
  {
    value: 'cash',
    label: 'Cash pickup',
    description: 'Collected in person at an agent, with an ID.',
  },
  {
    value: 'wallet',
    label: 'USDC to a Stellar wallet',
    description: 'Paid in USDC to a wallet address they give us.',
  },
] as const;

interface Args extends ComponentProps<typeof RadioGroup> {
  error?: string;
}

function MethodPicker({ error, ...args }: Args) {
  return (
    <div className="max-w-sm">
      <Field label="Payout method" hint="The recipient can change this later." error={error}>
        <RadioGroup {...args}>
          {METHODS.map(({ value, label, description }) => (
            <RadioGroupItem key={value} value={value} label={label} description={description} />
          ))}
        </RadioGroup>
      </Field>
    </div>
  );
}

const meta = {
  title: 'Primitives/RadioGroup',
  component: MethodPicker,
  args: { defaultValue: 'mobile' },
} satisfies Meta<typeof MethodPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Hover: Story = { parameters: HOVER };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = { args: { disabled: true } };

export const Invalid: Story = {
  args: { defaultValue: '', error: 'Choose how the recipient is paid.' },
};

/**
 * Choices the principal named themselves stay bare: the name is the whole
 * content, and a made up line under each one would be noise.
 */
export const NamedByThePrincipal: Story = {
  render: () => (
    <div className="max-w-sm">
      <Field label="Mandate">
        <RadioGroup defaultValue="annotation">
          <RadioGroupItem value="annotation" label="Annotation team, October" />
          <RadioGroupItem value="bounties" label="Bounties, Q4" />
          <RadioGroupItem value="grants" label="Grants, 2026" />
        </RadioGroup>
      </Field>
    </div>
  ),
};
