// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * The props that stop an overlay closing while a money action is waiting for
 * the server. Money is never optimistic: until the server confirms, the
 * person keeps looking at what they asked for, so a stray Escape, a click on
 * the scrim or the close button cannot leave them wondering whether it
 * happened.
 *
 * Radix fires its own Escape and outside handlers on the content, and also
 * listens on the document, so both are stopped here.
 */
export function pendingLock(pending: boolean) {
  if (!pending) return {};
  const stop = (event: { preventDefault: () => void }) => {
    event.preventDefault();
  };
  return {
    'aria-busy': true as const,
    onEscapeKeyDown: stop,
    onPointerDownOutside: stop,
    onInteractOutside: stop,
    // Radix's document level Escape listener runs whatever the content does,
    // so the key is stopped before it reaches the document as well.
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
      }
    },
  };
}
