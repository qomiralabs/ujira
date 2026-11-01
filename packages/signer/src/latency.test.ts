// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// LatencyWindow keeps the last LATENCY_WINDOW samples and reports their
// 95th percentile by nearest rank, or null before the first one.

import { describe, expect, it } from 'vitest';

import { LATENCY_WINDOW, LatencyWindow } from './latency.js';

describe('LatencyWindow', () => {
  it('is null before the first sample', () => {
    expect(new LatencyWindow().p95()).toBeNull();
  });

  it('takes the nearest rank', () => {
    const window = new LatencyWindow();
    for (let ms = 1; ms <= 100; ms += 1) window.record(101 - ms);
    expect(window.p95()).toBe(95);
    const one = new LatencyWindow();
    one.record(7);
    expect(one.p95()).toBe(7);
  });

  it('forgets samples older than the window', () => {
    const window = new LatencyWindow();
    for (let i = 0; i < LATENCY_WINDOW; i += 1) window.record(1000);
    for (let i = 0; i < LATENCY_WINDOW; i += 1) window.record(2);
    expect(window.p95()).toBe(2);
  });
});
