// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import type { Money, TokenAmount } from '@ujira/core';
import { useId, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Amount } from '../money/amount.js';
import { StatusBadge, type BadgeStatus } from './status-badge.js';

export interface PayoutCardProps extends Omit<ComponentProps<'article'>, 'children'> {
  /** Who is paid, as the principal knows them. */
  recipient: string;
  /** What they receive, in their currency. */
  amount: Money;
  /** The USD or USDC equivalent, shown smaller under the amount. */
  secondary?: Money | TokenAmount;
  status: BadgeStatus;
  /** How the money reaches them, in words: "USDC to Stellar wallet". */
  method: string;
  /** Where they are paid: the country of the corridor. */
  corridor: string;
  /** When it arrives or was paid, with the word for which. */
  timing?: { label: string; value: ReactNode };
  /** The one thing to do with this payout, if there is one. */
  action?: ReactElement;
}

/**
 * One payout as a card: who is paid and how much lead, then the status, and
 * under a perforation rule how and where. The stacked form of a payout row
 * on a phone, and the item of the approvals queue. Quiet: a 1px rule, the
 * card radius, no shadow and no card inside it.
 */
export function PayoutCard({
  recipient,
  amount,
  secondary,
  status,
  method,
  corridor,
  timing,
  action,
  className,
  ...rest
}: PayoutCardProps) {
  const heading = useId();
  return (
    <article
      data-slot="payout-card"
      aria-labelledby={heading}
      // min-w-0 lets the card narrow in a grid or flex row: the name then
      // truncates instead of pushing a phone screen sideways.
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-card border border-rule bg-surface p-4',
        className,
      )}
      {...rest}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 id={heading} className="min-w-0 truncate text-body-s font-medium text-text">
          {recipient}
        </h3>
        <StatusBadge status={status} />
      </div>
      <Amount
        value={amount}
        size="large"
        className="items-start text-text"
        {...(secondary === undefined ? {} : { secondary })}
      />
      {/* Stands in for the brand perforation until the payments graphics land. */}
      <div
        data-slot="perforation"
        aria-hidden="true"
        className="border-t-2 border-dotted border-rule-strong"
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-s">
        <dt className="text-text-secondary">Method</dt>
        <dd className="text-text">{method}</dd>
        <dt className="text-text-secondary">Corridor</dt>
        <dd className="text-text">{corridor}</dd>
        {timing === undefined ? null : (
          <>
            <dt className="text-text-secondary">{timing.label}</dt>
            <dd className="text-text">{timing.value}</dd>
          </>
        )}
      </dl>
      {action === undefined ? null : <div className="flex">{action}</div>}
    </article>
  );
}
