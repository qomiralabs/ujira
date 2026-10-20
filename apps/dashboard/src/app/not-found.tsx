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
      The link may be old or mistyped. Every page is in the navigation, or press Ctrl K (⌘ K on a
      Mac) to jump to one.
    </EmptyState>
  );
}
