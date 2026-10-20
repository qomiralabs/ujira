// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import Link from 'next/link';

import { buttonClass } from '../patterns/button';
import { ErrorState } from '../patterns/error-state';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <ErrorState
      title="This page did not load"
      reference={error.digest}
      actions={
        <>
          <button type="button" onClick={reset} className={buttonClass('primary')}>
            Try again
          </button>
          <Link href="/" className={buttonClass('secondary')}>
            Go to overview
          </Link>
        </>
      }
    >
      Something failed on our side while loading it. Loading a page never moves money, so nothing
      was paid or changed. Try again. If it keeps happening, write to support@ujira.co
      {error.digest ? ' and quote the reference below.' : '.'}
    </ErrorState>
  );
}
