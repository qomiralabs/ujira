// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { formatMoney as formatCoreMoney } from '@ujira/core';
import type { Money } from '@ujira/core';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { useAmountSettings } from '../money/amount-context.js';
import { AMOUNT_TEXT } from '../money/amount-styles.js';
import { localeDirection } from '../money/format.js';

/** The one number a card shows: an amount, a count, or a short text such as "4 min". */
export type KpiValue = { amount: Money } | { count: number } | { text: string };

export interface KpiDelta {
  change: 'up' | 'down' | 'none';
  /** The size of the change as a plain decimal, such as "12" or "3.5". Not needed for none. */
  percent?: string;
  /** What it is measured against, in words: "last week". */
  comparedWith: string;
}

export interface KpiCardProps {
  title: string;
  value: KpiValue;
  /** The period the value covers, in words: "This week", "1 to 7 Nov". */
  period: string;
  delta?: KpiDelta;
  /** A small trend chart without axes. Decorative: the value and the delta carry the meaning. */
  sparkline?: ReactNode;
  /** The one thing to do about this number, if there is one. */
  action?: ReactElement;
  className?: string;
}

const PLAIN_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** The delta in words: "Up 12 percent on last week", "No change on last week". */
export function deltaText({ change, percent, comparedWith }: KpiDelta): string {
  if (change === 'none') return `No change on ${comparedWith}`;
  if (percent === undefined || !PLAIN_DECIMAL.test(percent)) {
    throw new TypeError('a delta needs its percentage as a plain decimal, such as "12" or "3.5"');
  }
  return `${change === 'up' ? 'Up' : 'Down'} ${percent} percent on ${comparedWith}`;
}

const DELTA_ICONS = { up: ArrowUpRight, down: ArrowDownRight, none: ArrowRight } as const;

/**
 * One measure on the overview: its title, the exact value in the mono face,
 * the period, and the change worded. The value is rendered final from the
 * first paint and never counts up. A quiet card: a 1px rule, no shadow, no
 * card inside it, one action at most.
 */
export function KpiCard({
  title,
  value,
  period,
  delta,
  sparkline,
  action,
  className,
}: KpiCardProps) {
  const settings = useAmountSettings();
  const headingId = useId();
  let text: string;
  if ('amount' in value) {
    text = formatCoreMoney(value.amount, settings);
  } else if ('count' in value) {
    if (!Number.isSafeInteger(value.count)) {
      throw new TypeError('a count is a whole number');
    }
    text = new Intl.NumberFormat(settings.locale, { numberingSystem: 'latn' }).format(value.count);
  } else {
    text = value.text;
  }
  const DeltaIcon = delta === undefined ? undefined : DELTA_ICONS[delta.change];

  return (
    <section
      data-slot="kpi-card"
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col gap-3 rounded-card border border-rule bg-surface p-5',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={headingId} className="text-body-s font-medium text-text-secondary">
          {title}
        </h3>
        <span className="text-body-s whitespace-nowrap text-text-subtle">{period}</span>
      </div>
      <p
        data-slot="kpi-value"
        dir={'text' in value ? undefined : localeDirection(settings.locale)}
        className={cn(AMOUNT_TEXT, 'text-amount-l text-text')}
      >
        {text}
      </p>
      {delta === undefined || DeltaIcon === undefined ? null : (
        <p className="flex items-center gap-1.5 text-body-s text-text-secondary">
          <DeltaIcon aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0" />
          {deltaText(delta)}
        </p>
      )}
      {sparkline === undefined ? null : (
        <div data-slot="kpi-sparkline" aria-hidden="true" className="h-8">
          {sparkline}
        </div>
      )}
      {action === undefined ? null : <div className="flex">{action}</div>}
    </section>
  );
}
