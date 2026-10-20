// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { FOCUS_RING } from './focus-ring.js';

// Shared by Input, Textarea and the Select trigger so the three read as one
// family. The border uses the subtle text token because a control's edge has
// to reach 3:1 against its ground.
export const TEXT_CONTROL = [
  'w-full min-w-0 rounded-control border border-text-subtle bg-surface font-sans text-body-s text-text',
  'placeholder:text-text-subtle',
  'transition-[color,background-color,border-color] duration-150 ease-out motion-reduce:transition-none',
  'hover:border-text',
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-text-subtle',
  'aria-invalid:border-blocked aria-invalid:hover:border-blocked',
  FOCUS_RING,
].join(' ');
