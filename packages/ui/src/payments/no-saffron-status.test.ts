// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Saffron is the coin: the mark, the amount, the one thing to do. It is never
// a status, so no status class may reach for it, in either spelling.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUS_SPECS, TONE_CLASSES } from './status-badge.js';

const SAFFRON = /accent|saffron|highlight/;

describe('status colours', () => {
  it('no status maps to the saffron token', () => {
    for (const [status, spec] of Object.entries(STATUS_SPECS)) {
      expect(TONE_CLASSES[spec.tone], status).not.toMatch(SAFFRON);
    }
  });

  it('the badge source never names saffron', () => {
    const source = readFileSync(join(import.meta.dirname, 'status-badge.tsx'), 'utf8');
    expect(source).not.toMatch(SAFFRON);
  });

  it('each tone uses only its own status colour', () => {
    expect(TONE_CLASSES.paid).not.toMatch(/waiting|blocked/);
    expect(TONE_CLASSES.waiting).not.toMatch(/paid|blocked/);
    expect(TONE_CLASSES.blocked).not.toMatch(/paid|waiting/);
    expect(TONE_CLASSES.neutral).not.toMatch(/paid|waiting|blocked/);
  });
});
