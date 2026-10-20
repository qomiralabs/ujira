// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { SNAPSHOTS } from './stories.ts';

/**
 * Says once, before anything runs, that this machine cannot compare
 * screenshots. Without it a green run on macOS looks like the whole gate,
 * when every story passed having compared no image.
 */
export default function globalSetup(): void {
  if (SNAPSHOTS) return;
  process.stdout.write(
    `\nScreenshots are compared on Linux only, and this run is ${process.platform}. ` +
      'axe and the focus ring still ran; no story screenshot was compared. ' +
      'See the README for the one command that checks them.\n\n',
  );
}
