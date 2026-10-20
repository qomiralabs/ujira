// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { useId, type ReactNode } from 'react';

import { Icon, type IconSource } from '../shell/icon';

interface EmptyStateProps {
  icon: IconSource;
  title: string;
  children: ReactNode;
  /** What to do next, when there is something to do. */
  action?: ReactNode;
}

/** A quiet card that says what will appear here and what to do to get there. */
export function EmptyState({ icon, title, children, action }: EmptyStateProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col items-start gap-4 rounded-card border border-rule bg-surface p-6 md:p-8"
    >
      <Icon source={icon} size={24} className="text-text-secondary" />
      <div className="flex max-w-prose flex-col gap-2">
        <h2 id={titleId} className="text-body font-semibold text-text">
          {title}
        </h2>
        <p className="text-body text-text-secondary">{children}</p>
      </div>
      {action}
    </section>
  );
}
