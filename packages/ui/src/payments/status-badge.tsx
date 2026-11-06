// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { PayoutStatus } from '@ujira/api-schema';
import {
  ArrowRight,
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentProps } from 'react';
import { BrandIcon } from '../icons/brand-icon.js';
import type { BrandIconName } from '../icons/brand-icons.generated.js';
import { cn } from '../lib/cn.js';

/** Where an approval request stands, for the approvals queue and its history. */
export type ApprovalState = 'approval_waiting' | 'approval_approved' | 'approval_rejected';

/** Where the money stands for the recipient, for receipts and payout legs. */
export type DeliveryState = 'in_transit' | 'arrived' | 'verified';

/** Every state a badge can show: each public payout status, plus the approval and delivery states. */
export type BadgeStatus = PayoutStatus | ApprovalState | DeliveryState;

/**
 * The colour family of a state. Paid, waiting and blocked are the brand's
 * payment colours. Neutral is for a state that is settled but is not a
 * payment outcome: a cancelled payout, an approval that was given.
 */
export type StatusTone = 'paid' | 'waiting' | 'blocked' | 'neutral';

type StatusIcon = { readonly brand: BrandIconName } | { readonly lucide: LucideIcon };

export interface StatusSpec {
  /** The word on the badge, in sentence case. It is always visible. */
  readonly word: string;
  readonly tone: StatusTone;
  readonly icon: StatusIcon;
}

/** A word, a tone and an icon for every state in `S`. Missing one is a compile error. */
export type StatusMap<S extends string> = Readonly<Record<S, StatusSpec>>;

export const STATUS_SPECS: StatusMap<BadgeStatus> = Object.freeze({
  queued: { word: 'Queued', tone: 'waiting', icon: { lucide: Clock } },
  submitting: { word: 'Submitting', tone: 'waiting', icon: { lucide: ArrowRight } },
  pending_approval: { word: 'Waiting for approval', tone: 'waiting', icon: { brand: 'approval' } },
  approved: { word: 'Approved', tone: 'waiting', icon: { lucide: Check } },
  settling: { word: 'Settling', tone: 'waiting', icon: { brand: 'rail' } },
  delivering: { word: 'Delivering', tone: 'waiting', icon: { brand: 'payout' } },
  partly_paid: { word: 'Partly paid', tone: 'waiting', icon: { lucide: CircleDashed } },
  paid: { word: 'Paid', tone: 'paid', icon: { lucide: CircleCheck } },
  needs_attention: { word: 'Needs attention', tone: 'blocked', icon: { lucide: TriangleAlert } },
  blocked: { word: 'Blocked', tone: 'blocked', icon: { lucide: Ban } },
  rejected: { word: 'Rejected', tone: 'blocked', icon: { lucide: CircleX } },
  cancelled: { word: 'Cancelled', tone: 'neutral', icon: { lucide: CircleSlash } },
  failed: { word: 'Failed', tone: 'blocked', icon: { lucide: CircleAlert } },
  approval_waiting: { word: 'Waiting for approval', tone: 'waiting', icon: { brand: 'approval' } },
  approval_approved: { word: 'Approved', tone: 'neutral', icon: { lucide: Check } },
  approval_rejected: { word: 'Rejected', tone: 'blocked', icon: { lucide: CircleX } },
  in_transit: { word: 'In transit', tone: 'waiting', icon: { brand: 'rail' } },
  arrived: { word: 'Arrived', tone: 'paid', icon: { lucide: CircleCheck } },
  verified: { word: 'Verified', tone: 'paid', icon: { lucide: ShieldCheck } },
});

/** Every badge state, in the order of the map. */
export const BADGE_STATUSES = Object.freeze(Object.keys(STATUS_SPECS) as BadgeStatus[]);

// The word takes the status text colour, which holds AA on bg and surface in
// both modes; the icon takes it too, so neither depends on a weaker fill. The
// border is the same colour, lighter, and only frames the word.
export const TONE_CLASSES: Readonly<Record<StatusTone, string>> = Object.freeze({
  paid: 'text-paid border-paid/40',
  waiting: 'text-waiting border-waiting/40',
  blocked: 'text-blocked border-blocked/40',
  neutral: 'text-text-secondary border-rule-strong',
});

export interface StatusBadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  status: BadgeStatus;
}

/**
 * A payment state as a word and an icon, never colour alone. The word is
 * what assistive technology reads; the icon is hidden from it.
 */
export function StatusBadge({ status, className, ...rest }: StatusBadgeProps) {
  const { word, tone, icon } = STATUS_SPECS[status];
  return (
    <span
      data-slot="status-badge"
      data-status={status}
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-label whitespace-nowrap uppercase',
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {'brand' in icon ? (
        <BrandIcon name={icon.brand} size={14} className="shrink-0" />
      ) : (
        <icon.lucide
          aria-hidden="true"
          size={14}
          strokeWidth={1.5}
          className="shrink-0"
          focusable="false"
        />
      )}
      {word}
    </span>
  );
}
