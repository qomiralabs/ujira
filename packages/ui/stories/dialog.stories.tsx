// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { Button } from '../src/primitives/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../src/primitives/dialog.js';
import { focusFirst } from './helpers.js';

interface Args extends ComponentProps<typeof Dialog> {
  pending?: boolean;
}

function ApprovePayout({ pending = false, ...args }: Args) {
  return (
    <Dialog open {...args}>
      <DialogContent pending={pending}>
        <DialogHeader>
          <DialogTitle>Approve this payout?</DialogTitle>
          <DialogDescription>
            Amara Okafor is paid KSh 1,500.00 to her M-Pesa account. It usually arrives in four
            minutes.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={pending}>
            Cancel
          </Button>
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
  component: ApprovePayout,
} satisfies Meta<typeof ApprovePayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Focus: Story = { play: focusFirst };

/**
 * Waiting for the server. The dialog cannot be dismissed and the close button
 * is gone, so nobody is left wondering whether the payout went out.
 */
export const Pending: Story = { args: { pending: true } };
