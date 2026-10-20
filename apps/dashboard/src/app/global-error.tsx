// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import './globals.css';

import { buttonClass } from '../patterns/button';
import { ErrorState } from '../patterns/error-state';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// Shown when the frame itself fails, so it brings its own document.
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto max-w-2xl px-4 py-12">
          <ErrorState
            title="The dashboard did not load"
            reference={error.digest}
            actions={
              <button type="button" onClick={reset} className={buttonClass('primary')}>
                Try again
              </button>
            }
          >
            Something failed on our side. Loading the dashboard never moves money, so nothing was
            paid or changed. Try again. If it keeps happening, write to support@ujira.co
            {error.digest ? ' and quote the reference below.' : '.'}
          </ErrorState>
        </main>
      </body>
    </html>
  );
}
