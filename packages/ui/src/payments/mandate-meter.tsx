// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import {
  add,
  compare,
  formatMoney as formatCoreMoney,
  isNegative,
  money,
  subtract,
} from '@ujira/core';
import type { Money } from '@ujira/core';
import { useId, type ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { useAmountSettings } from '../money/amount-context.js';
import { Amount } from '../money/amount.js';

const WHOLE = 10_000n;

export interface MeterSegments {
  /** Each part of the bar in basis points of the budget. They always add up to the whole bar. */
  usedBp: bigint;
  committedBp: bigint;
  remainingBp: bigint;
  /** What is left to spend, never below zero. */
  remaining: Money;
  /** How far used and committed together go past the budget, zero when they do not. */
  over: Money;
}

/** `part` of `whole` in basis points, rounded down, held between 0 and the whole bar. */
function share(part: Money, whole: Money): bigint {
  if (isNegative(part)) return 0n;
  const bp = (part.amount * WHOLE) / whole.amount;
  return bp > WHOLE ? WHOLE : bp;
}

/**
 * Splits a mandate budget into used, committed and remaining, in integer
 * basis points. Used and committed are each rounded down and committed is
 * held to what used leaves, so the bar is never wider than the budget; what
 * remains takes the rest, so the three always fill it exactly. A zero budget
 * draws an empty bar. All three amounts must share one currency.
 */
export function meterSegments(budget: Money, used: Money, committed: Money): MeterSegments {
  const claimed = add(used, committed);
  const left = subtract(budget, claimed);
  const zero = money(0n, budget.currency);
  const remaining = isNegative(left) ? zero : left;
  const over = isNegative(left) ? subtract(claimed, budget) : zero;
  if (compare(budget, zero) <= 0) {
    return { usedBp: 0n, committedBp: 0n, remainingBp: 0n, remaining, over };
  }
  const usedBp = share(used, budget);
  const committedRaw = share(committed, budget);
  const committedBp = committedRaw > WHOLE - usedBp ? WHOLE - usedBp : committedRaw;
  return { usedBp, committedBp, remainingBp: WHOLE - usedBp - committedBp, remaining, over };
}

/** Basis points as a CSS percentage with two places, from integers only: 3333n is "33.33%". */
export function percentOf(bp: bigint): string {
  const cents = (bp % 100n).toString().padStart(2, '0');
  return `${(bp / 100n).toString()}.${cents}%`;
}

export interface MandateMeterProps extends Omit<ComponentProps<'figure'>, 'children'> {
  /** The mandate's budget for the period. */
  budget: Money;
  /** Paid out of the budget so far. */
  used: Money;
  /** Held for payouts that are approved or on their way, not yet paid. */
  committed: Money;
  /** What the budget is, in a few words. */
  label?: string;
}

const SWATCH = 'inline-block size-2.5 shrink-0 rounded-[2px]';

/**
 * A mandate budget as a horizontal bullet bar: used, committed and remaining,
 * each with its exact amount and a plain label. Committed is hatched as well
 * as coloured, so the parts never depend on colour alone. Screen readers
 * hear one sentence with every amount.
 */
export function MandateMeter({
  budget,
  used,
  committed,
  label = 'Budget',
  className,
  ...rest
}: MandateMeterProps) {
  const settings = useAmountSettings();
  const hatch = useId();
  const segments = meterSegments(budget, used, committed);
  const format = (value: Money) => formatCoreMoney(value, settings);
  const sentence = [
    `${format(used)} used`,
    `${format(committed)} committed`,
    `${format(segments.remaining)} remaining of ${format(budget)}`,
    ...(segments.over.amount > 0n ? [`${format(segments.over)} over`] : []),
  ].join(', ');

  return (
    <figure data-slot="mandate-meter" className={cn('flex flex-col gap-2', className)} {...rest}>
      <figcaption className="flex items-baseline justify-between gap-3 text-body-s">
        <span className="text-text-secondary">{label}</span>
        <Amount value={budget} size="data" className="text-text" />
      </figcaption>
      <svg
        data-slot="mandate-meter-bar"
        role="img"
        aria-label={sentence}
        width="100%"
        height="12"
        className="block overflow-visible"
      >
        <defs>
          <pattern
            id={hatch}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" className="fill-viz-categorical-3" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="6"
              strokeWidth="3"
              className="stroke-viz-categorical-1"
            />
          </pattern>
        </defs>
        <rect
          data-segment="used"
          x="0"
          y="0"
          width={percentOf(segments.usedBp)}
          height="12"
          className="fill-viz-categorical-1"
        />
        <rect
          data-segment="committed"
          x={percentOf(segments.usedBp)}
          y="0"
          width={percentOf(segments.committedBp)}
          height="12"
          fill={`url(#${hatch})`}
        />
        <rect
          data-segment="remaining"
          x={percentOf(segments.usedBp + segments.committedBp)}
          y="0.5"
          width={percentOf(segments.remainingBp)}
          height="11"
          className="fill-bg stroke-rule-strong"
          strokeWidth="1"
        />
      </svg>
      <dl
        data-slot="mandate-meter-legend"
        aria-hidden="true"
        className="grid grid-cols-1 gap-x-4 gap-y-1 text-body-s sm:grid-cols-3"
      >
        <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:justify-start">
          <dt className="flex items-center gap-1.5 text-text-secondary">
            <span className={cn(SWATCH, 'bg-viz-categorical-1')} />
            Used
          </dt>
          <dd>
            <Amount value={used} size="data" className="text-text" />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:justify-start">
          <dt className="flex items-center gap-1.5 text-text-secondary">
            <span
              className={cn(SWATCH, 'border-2 border-viz-categorical-1 bg-viz-categorical-3')}
            />
            Committed
          </dt>
          <dd>
            <Amount value={committed} size="data" className="text-text" />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:justify-start">
          <dt className="flex items-center gap-1.5 text-text-secondary">
            <span className={cn(SWATCH, 'border border-rule-strong bg-bg')} />
            Remaining
          </dt>
          <dd>
            <Amount value={segments.remaining} size="data" className="text-text" />
          </dd>
        </div>
      </dl>
    </figure>
  );
}
