// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Pins the colour vision simulation to Machado, Oliveira and Fernandes
// (2009), "A Physiologically-based Model for Simulation of Color Vision
// Deficiency", at severity 1.0. The expected values below were computed
// outside this package from the published matrices: decode sRGB to linear,
// multiply, clamp to [0, 1], encode back to 8 bit sRGB. They are written
// out as literals so that a wrong matrix entry, a missing transfer function
// or a simulation that returns its input fails here.

import { describe, expect, it } from 'vitest';

import { colourDifference, simulateHex } from './colour.ts';
import type { Vision } from './colour.ts';

// Half an 8 bit step: the reference is unrounded, so any real deviation
// from the published model shows up well beyond this.
const TOLERANCE = 0.5;

type Expected = readonly [string, readonly [number, number, number]];

const REFERENCE: Readonly<Record<Exclude<Vision, 'normal'>, readonly Expected[]>> = {
  protanopia: [
    ['#ff0000', [108.79, 95.03, 0.0]],
    ['#00ff00', [255.0, 229.35, 0.0]],
    ['#0000ff', [0.0, 88.71, 255.0]],
    ['#ffff00', [255.0, 243.54, 0.0]],
    ['#ff8000', [165.64, 145.25, 0.0]],
    ['#008080', [118.55, 120.98, 128.23]],
    ['#808080', [128.0, 128.0, 128.0]],
  ],
  deuteranopia: [
    ['#ff0000', [163.22, 144.28, 0.0]],
    ['#00ff00', [238.69, 214.01, 58.44]],
    ['#0000ff', [0.0, 61.5, 251.48]],
    ['#ffff00', [255.0, 249.61, 49.35]],
    ['#ff8000', [196.17, 174.37, 0.0]],
    ['#008080', [103.34, 109.83, 128.7]],
    ['#808080', [128.0, 128.0, 128.0]],
  ],
  tritanopia: [
    ['#ff0000', [255.0, 0.0, 14.89]],
    ['#00ff00', [0.0, 247.08, 216.65]],
    ['#0000ff', [0.0, 107.2, 149.76]],
    ['#ffff00', [255.0, 237.68, 217.31]],
    ['#ff8000', [255.0, 98.14, 109.35]],
    ['#008080', [0.0, 132.54, 127.72]],
    ['#808080', [128.0, 128.0, 128.0]],
  ],
};

const cases = (Object.keys(REFERENCE) as (keyof typeof REFERENCE)[]).flatMap((vision) =>
  REFERENCE[vision].map(([hex, expected]) => [vision, hex, expected] as const),
);

describe('colour vision simulation against Machado 2009 at full severity', () => {
  it.each(cases)('%s of %s matches the published model', (vision, hex, expected) => {
    const actual = simulateHex(hex, vision);
    expect(actual).toHaveLength(3);
    actual.forEach((channel, i) => {
      expect(Math.abs(channel - (expected[i] ?? Number.NaN))).toBeLessThanOrEqual(TOLERANCE);
    });
  });

  it('covers at least five saturated colours for every deficiency', () => {
    for (const rows of Object.values(REFERENCE)) {
      const saturated = rows.filter(([hex]) => hex !== '#808080');
      expect(saturated.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('changes a saturated red for every deficiency', () => {
    const red = [255, 0, 0];
    for (const vision of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const simulated = simulateHex('#ff0000', vision);
      const moved = simulated.reduce(
        (sum, channel, i) => sum + Math.abs(channel - (red[i] ?? 0)),
        0,
      );
      // Many 8 bit steps, so rounding or clamping alone can never explain it.
      expect(moved).toBeGreaterThan(10);
    }
  });

  it('leaves normal vision unchanged', () => {
    expect(simulateHex('#ff8000', 'normal').map((c) => Math.round(c))).toEqual([255, 128, 0]);
  });

  it('feeds the simulation into colourDifference', () => {
    // Red and green are far apart for normal vision and much closer for the
    // red green deficiencies; an unsimulated difference would not shrink.
    const normal = colourDifference('#ff0000', '#00ff00', 'normal');
    expect(colourDifference('#ff0000', '#00ff00', 'protanopia')).toBeLessThan(normal / 2);
    expect(colourDifference('#ff0000', '#00ff00', 'deuteranopia')).toBeLessThan(normal / 2);
  });
});
