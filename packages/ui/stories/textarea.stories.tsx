// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Field } from '../src/primitives/field.js';
import { Textarea } from '../src/primitives/textarea.js';
import { focusFirst, HOVER } from './helpers.js';

const meta = {
  title: 'Primitives/Textarea',
  component: Textarea,
  args: { placeholder: 'What the payout is for' },
  render: (args) => (
    <div className="max-w-md">
      <Field label="Note to the recipient" hint="Shown on their receipt.">
        <Textarea {...args} />
      </Field>
    </div>
  ),
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Filled: Story = {
  args: { defaultValue: 'Annotation batch 14, 1,200 images labelled. Thank you, Amara.' },
};

export const Hover: Story = { parameters: HOVER };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'Annotation batch 14.' },
};

export const Invalid: Story = {
  args: { defaultValue: '' },
  render: (args) => (
    <div className="max-w-md">
      <Field label="Note to the recipient" error="Add a short note so they know what this is for.">
        <Textarea {...args} />
      </Field>
    </div>
  ),
};
