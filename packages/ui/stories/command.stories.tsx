// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { BrandIcon } from '../src/icons/brand-icon.js';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../src/primitives/command.js';

function Palette({ search }: { search?: string }) {
  return (
    <div className="max-w-md overflow-hidden rounded-overlay border border-rule">
      <Command label="Go to a page or find a payout">
        <CommandInput
          placeholder="Search pages"
          aria-label="Search pages"
          {...(search === undefined ? {} : { defaultValue: search })}
        />
        <CommandList>
          <CommandEmpty>No page matches that. Try a shorter word.</CommandEmpty>
          <CommandGroup heading="Pages">
            <CommandItem value="Payouts every payout and where it is">
              <BrandIcon name="payout" size={16} />
              Payouts
            </CommandItem>
            <CommandItem value="Mandates budgets and rules">
              <BrandIcon name="mandate" size={16} />
              Mandates
            </CommandItem>
            <CommandItem value="Receipts proof of every payment">
              <BrandIcon name="receipt" size={16} />
              Receipts
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

const meta = {
  title: 'Primitives/Command',
  component: Palette,
} satisfies Meta<typeof Palette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A search with no match says what to try instead. */
export const NoResults: Story = { args: { search: 'zzz' } };
