// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Signing latency over the most recent signatures, for health. A fixed
// window keeps memory flat however long the process runs, and recent
// samples are what tell a slowing key manager from a healthy one.

export const LATENCY_WINDOW = 256;

export class LatencyWindow {
  readonly #samples: number[] = [];
  #next = 0;

  record(ms: number): void {
    if (this.#samples.length < LATENCY_WINDOW) {
      this.#samples.push(ms);
    } else {
      this.#samples[this.#next] = ms;
    }
    this.#next = (this.#next + 1) % LATENCY_WINDOW;
  }

  /** The 95th percentile by nearest rank, or null before the first sample. */
  p95(): number | null {
    if (this.#samples.length === 0) return null;
    const sorted = [...this.#samples].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
  }
}
