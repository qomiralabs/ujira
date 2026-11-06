// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@ujira/ui';
import { Copy } from 'lucide-react';
import { useState, type RefObject } from 'react';

import { formatDateTime, isoOf } from '../patterns/dates';

export interface RevealedKey {
  /** The whole key. Held only while this dialog is open. */
  secret: string;
  label: string;
  /** Set when this key replaces another, which keeps working until then. */
  previousKeyExpiresAt?: string | undefined;
}

interface RevealKeyDialogProps {
  revealed: RevealedKey;
  onClose: () => void;
  /** Where focus goes when the dialog closes, since no trigger opened it. */
  returnFocus: RefObject<HTMLElement | null>;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Shows a new key the one time it can be seen. Closing it drops the key: the
 * caller clears its state, so the text leaves the page with the dialog.
 */
export function RevealKeyDialog({ revealed, onClose, returnFocus }: RevealKeyDialogProps) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const replacing = revealed.previousKeyExpiresAt !== undefined;

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopy('copied');
    } catch {
      // Whatever went wrong is not shown or logged: it could quote the key.
      setCopy('failed');
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        closeLabel="Close. This key will not be shown again"
        // A stray click beside the dialog must not throw the key away.
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected === true) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <DialogTitle>
          {replacing ? 'Copy the replacement key' : 'Copy your new API key'}
        </DialogTitle>
        <DialogDescription>
          This is the only time UJIRA shows this key. Put it where your software keeps its secrets
          now, such as a secret manager. If it is ever lost, rotate the key to get a new one.
        </DialogDescription>

        <div className="flex flex-col gap-2">
          <p className="font-mono text-label text-text-secondary uppercase">{revealed.label}</p>
          <code
            translate="no"
            className="block rounded-control border border-rule bg-bg p-3 font-mono text-data break-all text-text select-all"
          >
            {revealed.secret}
          </code>
          <p aria-live="polite" className="min-h-6 text-body-s text-text-secondary">
            {copy === 'copied'
              ? 'Copied. Paste it where your software keeps secrets.'
              : copy === 'failed'
                ? 'Copying did not work in this browser. Select the key above and copy it yourself.'
                : ''}
          </p>
        </div>

        {replacing && revealed.previousKeyExpiresAt !== undefined ? (
          <p className="text-body-s text-text">
            The old key keeps working until{' '}
            <time dateTime={isoOf(revealed.previousKeyExpiresAt)}>
              {formatDateTime(revealed.previousKeyExpiresAt)}
            </time>
            . Switch your software to this one before then.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
          <Button
            variant="primary"
            icon={<Copy aria-hidden="true" strokeWidth={1.5} />}
            onClick={() => void copyKey()}
          >
            Copy key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
