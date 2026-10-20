// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Play function for Focus stories: moves focus to the first focusable element
 * in the story, the way the Tab key would, so the keyboard ring shows.
 */
export function focusFirst({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> {
  const target = canvasElement.querySelector<HTMLElement>(FOCUSABLE);
  if (target === null) throw new Error('Focus story has nothing focusable');
  target.focus({ focusVisible: true });
  return Promise.resolve();
}

/** Parameters for Hover stories: draws every element as if the pointer were over it. */
export const HOVER = { pseudo: { hover: true } } as const;
