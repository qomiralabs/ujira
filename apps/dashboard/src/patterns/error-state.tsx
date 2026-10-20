// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { useId, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

import { Icon } from '../shell/icon';

interface ErrorStateProps {
  title: string;
  /** What happened and what to do about it, in plain words. */
  children: ReactNode;
  /** Quoted to support so they can find the failure in the logs. */
  reference?: string | undefined;
  actions?: ReactNode;
}

export function ErrorState({ title, children, reference, actions }: ErrorStateProps) {
  const titleId = useId();
  return (
    <section
      role="alert"
      aria-labelledby={titleId}
      className="flex flex-col items-start gap-4 rounded-card border border-rule bg-surface p-6 md:p-8"
    >
      <Icon source={{ lucide: CircleAlert }} size={24} className="text-text-secondary" />
      <div className="flex max-w-prose flex-col gap-2">
        <h2 id={titleId} className="text-body font-semibold text-text">
          {title}
        </h2>
        <p className="text-body text-text-secondary">{children}</p>
      </div>
      {reference ? (
        <p className="text-body-s text-text-secondary">
          Reference <span className="font-mono text-data text-text select-all">{reference}</span>
        </p>
      ) : null}
      {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
    </section>
  );
}
