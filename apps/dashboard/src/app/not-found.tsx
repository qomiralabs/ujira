// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import Link from 'next/link';
import { Compass } from 'lucide-react';

import { buttonClass } from '../patterns/button';
import { EmptyState } from '../patterns/empty-state';

export default function NotFound() {
  return (
    <EmptyState
      icon={{ lucide: Compass }}
      title="There is no page at this address"
      action={
        <Link href="/" className={buttonClass('secondary')}>
          Go to overview
        </Link>
      }
    >
      {/*
       * The command symbol below is deliberate, for the same reason it is
       * kept in the top bar: it is the right character for that key. Leave
       * it in place when sweeping for non ASCII characters.
       */}
      The link may be old or mistyped. Use the menu to find the page you want, or press Ctrl K (⌘ K
      on a Mac) to search for it.
    </EmptyState>
  );
}
