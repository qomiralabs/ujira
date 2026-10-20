// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { LucideIcon } from 'lucide-react';
import { BrandIcon, type BrandIconName } from '@ujira/ui';

/** A brand icon by name, or a Lucide icon for everything the brand set does not cover. */
export type IconSource = { brand: BrandIconName } | { lucide: LucideIcon };

interface IconProps {
  source: IconSource;
  /**
   * Defaults to 24, the grid the brand icons are drawn on. A smaller size
   * keeps the 1.5px stroke rather than scaling it down with the box, so the
   * weight matches the sprite whatever the size.
   */
  size?: number;
  className?: string;
}

/**
 * Every icon in the dashboard goes through here, so Lucide always matches the
 * brand grid: 1.5px stroke, round caps and joins. Icons are decorative; the
 * word next to them, or the control's label, carries the meaning.
 */
export function Icon({ source, size = 24, className }: IconProps) {
  if ('brand' in source) {
    return <BrandIcon name={source.brand} size={size} className={className} />;
  }
  const Lucide = source.lucide;
  return (
    <Lucide
      size={size}
      strokeWidth={1.5}
      nonScalingStroke
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    />
  );
}
