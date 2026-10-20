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
    `\nScreenshots are compared on Linux only, and this run is ${process.platform}, ` +
      'so no story screenshot was compared. Everything else ran: axe in both ' +
      'modes, the keyboard focus ring, and the sideways scroll check at every ' +
      'width each story is taken at. See the README for the one command that ' +
      'checks the screenshots.\n\n',
  );
}
