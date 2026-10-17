// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { modes } from './tokens.generated.js';

export {
  density,
  focus,
  fonts,
  modes,
  motion,
  palette,
  radius,
  shadow,
  status,
  typeScale,
  viz,
} from './tokens.generated.js';

/** A colour mode. Both modes carry exactly the same token names. */
export type ColorMode = keyof typeof modes;

/** Name of a semantic token that exists in every colour mode. */
export type ModeToken = keyof (typeof modes)['light'];

/** The CSS custom property that carries a token, for inline styles and canvas reads. */
export function cssVar(token: string): `var(--ujira-${string})` {
  return `var(--ujira-${token})`;
}
