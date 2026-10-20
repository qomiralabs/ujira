// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one place UJIRA appears in an embedded component: a single line in the
// footer with the mark at 16px, in the integrator's own text colour. The
// widget carries no other UJIRA branding.

import { html, type TemplateResult } from 'lit';

import { markShapes, markViewBox } from '../brand/mark.generated.js';

export function footer(byline: string): TemplateResult {
  return html`<p class="footer">
    <svg viewBox=${markViewBox} aria-hidden="true">${markShapes}</svg>
    <span>${byline}</span>
  </p>`;
}
