// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  summary: string;
  /** At most one action, usually the page's primary one. */
  action?: ReactNode;
}

export function PageHeader({ title, summary, action }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex max-w-prose flex-col gap-1">
        <h1 className="text-title text-text">{title}</h1>
        <p className="text-body-s text-text-secondary">{summary}</p>
      </div>
      {action}
    </header>
  );
}
