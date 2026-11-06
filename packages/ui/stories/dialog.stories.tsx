// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { BrandIcon } from '../src/icons/brand-icon.js';
import { Button } from '../src/primitives/button.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '../src/primitives/dialog.js';

function ApproveDialog({ open, pending = false }: { open?: boolean; pending?: boolean }) {
  return (
    <Dialog {...(open === undefined ? {} : { defaultOpen: open })}>
      <DialogTrigger asChild>
        <Button variant="primary" icon={<BrandIcon name="approval" size={16} />}>
          Review payout
        </Button>
      </DialogTrigger>
      <DialogContent pending={pending}>
        <DialogTitle>Approve this payout?</DialogTitle>
        <DialogDescription>
          Amara Okafor receives 20,000.00 naira from Annotation batch 14. It leaves as soon as you
          approve.
        </DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={pending}>Not now</Button>
          </DialogClose>
          <Button variant="primary" loading={pending}>
            Approve payout
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const meta = {
  title: 'Primitives/Dialog',
  component: ApproveDialog,
} satisfies Meta<typeof ApproveDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Closed: only the trigger shows. */
export const Default: Story = {};

export const Open: Story = { args: { open: true } };

/** Waiting for the server: Escape, a click outside and the close button do nothing. */
export const OpenPending: Story = { args: { open: true, pending: true } };
