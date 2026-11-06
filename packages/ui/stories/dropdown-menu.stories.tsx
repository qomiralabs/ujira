// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download, Ellipsis, Copy } from 'lucide-react';
import { BrandIcon } from '../src/icons/brand-icon.js';
import { Button } from '../src/primitives/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../src/primitives/dropdown-menu.js';

function PayoutActions({ open }: { open?: boolean }) {
  return (
    <div className="flex justify-center pt-2">
      <DropdownMenu {...(open === undefined ? {} : { defaultOpen: open })}>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="More for this payout">
            <Ellipsis aria-hidden="true" strokeWidth={1.5} className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          <DropdownMenuLabel>Payout</DropdownMenuLabel>
          <DropdownMenuItem>
            <BrandIcon name="receipt" size={16} />
            Open the receipt
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Copy aria-hidden="true" strokeWidth={1.5} />
            Copy the payout ID
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>
            <Download aria-hidden="true" strokeWidth={1.5} />
            Download the CSV
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const meta = {
  title: 'Primitives/DropdownMenu',
  component: PayoutActions,
} satisfies Meta<typeof PayoutActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Open: Story = { args: { open: true } };
