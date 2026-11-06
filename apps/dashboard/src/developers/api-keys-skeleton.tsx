// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the page shows before the screen and its keys arrive. It is built from
// the dashboard's own light patterns only, so it costs the page almost nothing
// while the screen itself loads as a chunk of its own.

import { Plus } from 'lucide-react';

import { buttonClass } from '../patterns/button';
import { PageHeader } from '../patterns/page-header';
import { Skeleton } from '../patterns/skeleton';
import { NAV_ITEMS } from '../shell/nav';

const DEVELOPERS = NAV_ITEMS.find((item) => item.segment === 'developers');

export const API_KEYS_INTRO =
  'Each key lets your own software or an agent use the UJIRA API for this project, within the permissions you give it. The whole key is shown once, when it is made.';

/** The list's shape while it loads: the table on wider screens, cards on a phone. */
export function KeysListSkeleton() {
  return (
    <div>
      <p role="status" className="sr-only">
        Loading API keys
      </p>
      <div className="hidden overflow-hidden rounded-card border border-rule bg-surface md:block">
        <div className="flex h-row items-center gap-8 border-b border-rule px-3">
          {['w-10', 'w-24', 'w-16', 'w-16', 'w-14', 'w-12'].map((width, column) => (
            // The columns never move, so their place is their identity.
            <Skeleton key={column} className={`h-3 ${width}`} />
          ))}
        </div>
        {[0, 1, 2, 3, 4].map((row) => (
          <div
            key={row}
            className="flex h-16 items-center gap-8 border-b border-rule px-3 last:border-b-0"
          >
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 md:hidden">
        {[0, 1, 2].map((card) => (
          <Skeleton key={card} className="h-40 w-full rounded-card" />
        ))}
      </div>
    </div>
  );
}

/** The whole page before the screen has loaded, at the size it will have. */
export function ApiKeysScreenSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={DEVELOPERS?.label ?? 'Developers'}
        summary={DEVELOPERS?.summary ?? ''}
        action={
          <button type="button" disabled className={buttonClass('primary', 'opacity-50')}>
            <Plus aria-hidden="true" strokeWidth={1.5} className="size-4" />
            Create API key
          </button>
        }
      />
      <section className="flex flex-col gap-4">
        <div className="flex max-w-prose flex-col gap-1">
          <h2 className="text-body font-semibold text-text">API keys</h2>
          <p className="text-body-s text-text-secondary">{API_KEYS_INTRO}</p>
        </div>
        <KeysListSkeleton />
      </section>
    </div>
  );
}
