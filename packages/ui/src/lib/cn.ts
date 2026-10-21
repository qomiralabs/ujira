// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { radius, shadow, typeScale } from '../tokens/tokens.generated.js';

// The brand theme replaces the Tailwind type sizes, radii and shadows, so the
// merge has to learn their names. Without this, text-body-s reads as a colour
// and a later text-text-secondary would silently drop it.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: Object.keys(typeScale),
      radius: Object.keys(radius),
      shadow: Object.keys(shadow),
    },
  },
});

/** Joins class names and resolves Tailwind conflicts so the last one wins. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
