// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { BrandIcon } from '../src/icons/brand-icon.js';
import { AlertDialog } from '../src/primitives/alert-dialog.js';
import { Button } from '../src/primitives/button.js';

interface Props {
  open?: boolean;
  pending?: boolean;
  word?: string;
}

function PauseMandate({ open = false, pending = false, word }: Props) {
  const [isOpen, setOpen] = useState(open);
  return (
    <>
      <Button
        variant="danger"
        icon={<BrandIcon name="pause" size={16} />}
        onClick={() => {
          setOpen(true);
        }}
      >
        Pause mandate
      </Button>
      <AlertDialog
        open={isOpen}
        onOpenChange={setOpen}
        title="Pause this mandate?"
        description={
          <p>
            No payouts leave <strong className="font-medium text-text">Annotation batch 14</strong>{' '}
            until you resume it. Payouts already on their way still arrive.
          </p>
        }
        confirmLabel="Pause mandate"
        confirmIcon={<BrandIcon name="pause" size={16} />}
        onConfirm={() => {
          setOpen(false);
        }}
        pending={pending}
        {...(word === undefined ? {} : { confirmationWord: word })}
      />
    </>
  );
}

const meta = {
  title: 'Primitives/AlertDialog',
  component: PauseMandate,
} satisfies Meta<typeof PauseMandate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Open: Story = { args: { open: true } };

/** A danger action: the button stays off until the shown word is typed exactly. */
export const OpenTypedConfirmation: Story = { args: { open: true, word: 'pause' } };

/** Waiting for the server: nothing dismisses it, and the action shows busy. */
export const OpenPending: Story = { args: { open: true, pending: true } };
