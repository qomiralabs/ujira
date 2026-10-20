// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Browser APIs jsdom leaves out that Radix, cmdk and the drawer call.

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

class NoopResizeObserver {
  observe(): void {
    // jsdom has no layout, so there is nothing to observe.
  }
  unobserve(): void {
    // Nothing observed.
  }
  disconnect(): void {
    // Nothing observed.
  }
}

// Assigned only where jsdom lacks them; the types claim they always exist.
function fill(target: object, name: string, value: unknown): void {
  if (!(name in target)) Object.defineProperty(target, name, { value, configurable: true });
}

fill(globalThis, 'ResizeObserver', NoopResizeObserver);
fill(Element.prototype, 'scrollIntoView', vi.fn());
fill(Element.prototype, 'hasPointerCapture', () => false);
fill(Element.prototype, 'releasePointerCapture', vi.fn());

// jsdom knows <dialog> but not its modal methods.
fill(HTMLDialogElement.prototype, 'showModal', function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
});
fill(HTMLDialogElement.prototype, 'close', function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset['theme'];
  delete document.documentElement.dataset['rail'];
});
