// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Shared by Dialog, AlertDialog and Sheet, so the three read as one family.
// Overlays are the one place the design system allows a shadow.

export const OVERLAY_SCRIM = [
  'fixed inset-0 z-50 bg-teal-ink/50',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
  'motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none',
].join(' ');

export const OVERLAY_PANEL = [
  'fixed z-50 flex flex-col gap-4 border border-rule bg-surface text-text shadow-overlay',
  'font-sans text-body-s',
  'duration-200 ease-out',
  'motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none',
].join(' ');
