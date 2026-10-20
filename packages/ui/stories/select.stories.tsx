// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { Field } from '../src/primitives/field.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../src/primitives/select.js';
import { focusFirst, HOVER } from './helpers.js';

interface Args extends ComponentProps<typeof Select> {
  error?: string;
}

function CorridorSelect({ error, ...args }: Args) {
  return (
    <div className="max-w-sm">
      <Field label="Corridor" error={error}>
        <Select {...args}>
          <SelectTrigger>
            <SelectValue placeholder="Choose a corridor" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Mobile money</SelectLabel>
              <SelectItem value="ke-mobile">Kenya, M-Pesa</SelectItem>
              <SelectItem value="gh-mobile">Ghana, MTN MoMo</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Bank</SelectLabel>
              <SelectItem value="ng-bank">Nigeria, bank transfer</SelectItem>
              <SelectItem value="ph-bank" disabled>
                Philippines, bank transfer
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

const meta = {
  title: 'Primitives/Select',
  component: CorridorSelect,
} satisfies Meta<typeof CorridorSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Chosen: Story = { args: { defaultValue: 'ng-bank' } };

export const Hover: Story = { parameters: HOVER };

export const Focus: Story = { play: focusFirst };

export const Disabled: Story = { args: { disabled: true, defaultValue: 'ke-mobile' } };

export const Invalid: Story = { args: { error: 'Choose where the recipient is paid.' } };

/**
 * The open list is modal and hides the page behind it, so the accessibility
 * check looks at the list only. The closed trigger is covered by the other stories.
 */
export const Open: Story = {
  args: { defaultOpen: true, defaultValue: 'ke-mobile' },
  parameters: { a11y: { context: { exclude: ['#storybook-root'] } } },
};
