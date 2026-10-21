// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import Link from 'next/link';

import { buttonClass } from '../patterns/button';
import { EmptyState } from '../patterns/empty-state';
import { PageHeader } from '../patterns/page-header';
import { NAV_ITEMS } from '../shell/nav';
import { PLACEHOLDERS } from '../shell/placeholders';

const overview = NAV_ITEMS[0];

export default function OverviewPage() {
  const placeholder = PLACEHOLDERS.overview;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={overview.label} summary={overview.summary} />
      <EmptyState
        icon={{ brand: 'mandate' }}
        title={placeholder.title}
        action={
          <Link href="/mandates" className={buttonClass('primary')}>
            Set up a mandate
          </Link>
        }
      >
        {placeholder.body}
      </EmptyState>
    </div>
  );
}
