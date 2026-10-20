// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConfirmDialog } from '../src/primitives/alert-dialog.js';
import { focusFirst } from './helpers.js';

const meta = {
  title: 'Primitives/AlertDialog',
  component: ConfirmDialog,
  args: {
    open: true,
    title: 'Revoke this mandate?',
    description: 'No further payouts can be made under it. Payouts already approved still settle.',
    confirmLabel: 'Revoke mandate',
    confirmWord: 'REVOKE',
    onConfirm: () => undefined,
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The action stays locked until the word is typed exactly as shown. */
export const Default: Story = {};

export const Focus: Story = { play: focusFirst };

/** An approval restates the amount and the recipient, and needs no typing. */
export const WithoutTyping: Story = {
  args: {
    title: 'Approve this payout?',
    description: 'Amara Okafor is paid KSh 1,500.00 to her M-Pesa account.',
    confirmLabel: 'Approve payout',
    confirmWord: undefined,
  },
};

export const Pending: Story = { args: { pending: true, confirmWord: undefined } };
