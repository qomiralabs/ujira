// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { SearchX } from 'lucide-react';
import { useId, type ReactElement } from 'react';
import { BrandIcon } from '../icons/brand-icon.js';
import type { BrandIconName } from '../icons/brand-icons.generated.js';
import { cn } from '../lib/cn.js';

export interface EmptyStateProps {
  /**
   * `nothing-yet`: nothing exists here so far. `no-results`: things exist but
   * the filters hide every one.
   */
  variant: 'nothing-yet' | 'no-results';
  /** One sentence on what is missing. */
  message: string;
  /** The one thing to do next: set something up, or clear the filters. */
  action: ReactElement;
  /** A short heading, when the screen has room for one. */
  title?: string;
  /** The brand icon for what is missing. No results always shows a search icon. */
  icon?: BrandIconName;
  className?: string;
}

/**
 * What a list shows when it has nothing to show: an icon, one sentence on what
 * is missing, and the one action that changes it. A quiet card, never a dead
 * end: the action is required.
 */
export function EmptyState({
  variant,
  message,
  action,
  title,
  icon = 'payout',
  className,
}: EmptyStateProps) {
  const headingId = useId();
  const messageId = useId();
  return (
    <section
      data-slot="empty-state"
      data-variant={variant}
      aria-labelledby={title === undefined ? messageId : headingId}
      className={cn(
        'flex flex-col items-start gap-4 rounded-card border border-rule bg-surface p-6 md:p-8',
        className,
      )}
    >
      {variant === 'no-results' ? (
        <SearchX aria-hidden="true" strokeWidth={1.5} className="size-6 text-text-secondary" />
      ) : (
        <BrandIcon name={icon} className="text-text-secondary" />
      )}
      <div className="flex max-w-prose flex-col gap-2">
        {title === undefined ? null : (
          <h2 id={headingId} className="text-body font-semibold text-text">
            {title}
          </h2>
        )}
        <p id={messageId} className="text-body text-text-secondary">
          {message}
        </p>
      </div>
      {action}
    </section>
  );
}
