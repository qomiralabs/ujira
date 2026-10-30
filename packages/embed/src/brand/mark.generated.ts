// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from the @ujira/ui design tokens and the brand mark in assets/brand.
// Do not edit by hand. Run `pnpm --filter @ujira/embed brand` to regenerate.

import { svg, type SVGTemplateResult } from 'lit';

/** The coordinate system the mark is drawn in. */
export const markViewBox = '0 0 100 100';

/**
 * The mark as supplied, in currentColor so it takes the colour of the text
 * next to it. Never redraw it, never set a colour on it here.
 */
export const markShapes: SVGTemplateResult = svg`<path d="M34 46C30 38 22 32 14 32C14 56 30 68 50 68C70 68 86 56 86 32C78 32 70 38 66 46" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="50" cy="40" r="11" fill="currentColor"></circle>`;
