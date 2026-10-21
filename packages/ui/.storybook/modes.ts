// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Shared by the preview and the browser tests, so the toolbar and the test
// run always cover the same modes and widths.

/** Colour modes, applied as data-theme on the html element like the apps do. */
export const THEMES = ['light', 'dark'] as const;

export type Theme = (typeof THEMES)[number];

/** The three widths every screen is checked at. */
export const VIEWPORTS = {
  mobile: { name: 'Mobile 375', width: 375, height: 812 },
  tablet: { name: 'Tablet 768', width: 768, height: 1024 },
  desktop: { name: 'Desktop 1440', width: 1440, height: 900 },
} as const;
