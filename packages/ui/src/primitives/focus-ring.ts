// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/**
 * The keyboard focus ring every interactive primitive carries: a 2px saffron
 * outline 2px out, with a teal ink ring in the gap so it stays visible on
 * cream, white and on a saffron button. The token stylesheet sets the same
 * ring globally; the classes keep it on even where a page resets outlines.
 */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:ring-2 focus-visible:ring-focus-inner';
