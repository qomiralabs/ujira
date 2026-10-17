// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { CSSProperties, SVGProps } from 'react';
import { brandIconShapes, type BrandIconName } from './brand-icons.generated.js';

// The brand grid is fixed, so props that would change it are not accepted.
type FixedProps =
  | 'children'
  | 'name'
  | 'viewBox'
  | 'fill'
  | 'stroke'
  | 'strokeWidth'
  | 'strokeLinecap'
  | 'strokeLinejoin'
  | 'role'
  | 'aria-label'
  | 'aria-hidden'
  | 'width'
  | 'height';

export interface BrandIconProps extends Omit<SVGProps<SVGSVGElement>, FixedProps> {
  /** One of the nine brand icons. */
  name: BrandIconName;
  /** Width and height. Defaults to 24, the size the icons are drawn on. */
  size?: number | string;
  /**
   * Accessible name. Leave it out when the icon sits next to a word that says
   * the same thing; the icon is then hidden from assistive technology.
   */
  label?: string;
}

// Inline style beats presentation attributes and class names, so the brand
// stroke is also written last into the style.
const LOCKED_STYLE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const satisfies CSSProperties;

/**
 * One of the nine brand icons, drawn from the brand sprite with a 1.5px round
 * stroke in currentColor. Set the colour with a text colour class.
 */
export function BrandIcon({ name, size = 24, label, style, ...rest }: BrandIconProps) {
  const a11y = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true, focusable: 'false' } as const);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
      {...a11y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...style, ...LOCKED_STYLE }}
      data-icon={name}
    >
      {brandIconShapes[name].map(([Shape, attributes], index) => (
        // The shapes of an icon never change order, so the index is a stable key.
        <Shape key={index} {...attributes} />
      ))}
    </svg>
  );
}
