// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/primitives/button.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '../src/primitives/sheet.js';

function PayoutSheet({ open }: { open?: boolean }) {
  return (
    <Sheet {...(open === undefined ? {} : { defaultOpen: open })}>
      <SheetTrigger asChild>
        <Button>Open payout</Button>
      </SheetTrigger>
      <SheetContent>
        <div className="flex flex-col gap-1 border-b border-rule p-6 pr-14">
          <SheetTitle className="text-title text-text">Payout to Amara Okafor</SheetTitle>
          <SheetDescription className="text-body-s text-text-secondary">
            Waiting for approval since 09:15.
          </SheetDescription>
        </div>
        <div className="flex-1 overflow-y-auto p-6 text-body-s text-text-secondary">
          The amount, the timeline and the receipt go here.
        </div>
      </SheetContent>
    </Sheet>
  );
}

const meta = {
  title: 'Primitives/Sheet',
  component: PayoutSheet,
} satisfies Meta<typeof PayoutSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Open: Story = { args: { open: true } };
