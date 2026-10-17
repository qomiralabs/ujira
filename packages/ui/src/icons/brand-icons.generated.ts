// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from the brand colour tokens, tokens/system.json and the brand icon sprite.
// Do not edit by hand. Run `pnpm --filter @ujira/ui tokens` to regenerate.

/** The nine brand icons, in sprite order. */
export const brandIconNames = [
  'mandate',
  'payout',
  'recipient',
  'approval',
  'receipt',
  'rail',
  'local-currency',
  'agent',
  'pause',
] as const;

/** Name of one of the nine brand icons. */
export type BrandIconName = (typeof brandIconNames)[number];

export type BrandIconTag = 'circle' | 'path' | 'rect';

export type BrandIconShapeAttributes = Readonly<
  Partial<
    Record<
      | 'd'
      | 'x'
      | 'y'
      | 'width'
      | 'height'
      | 'rx'
      | 'ry'
      | 'cx'
      | 'cy'
      | 'r'
      | 'x1'
      | 'y1'
      | 'x2'
      | 'y2'
      | 'points',
      string
    >
  >
>;

export type BrandIconShape = readonly [tag: BrandIconTag, attributes: BrandIconShapeAttributes];

/** Shapes of each icon, read from the brand sprite. */
export const brandIconShapes: Readonly<Record<BrandIconName, readonly BrandIconShape[]>> = {
  mandate: [
    [
      'rect',
      {
        x: '5.25',
        y: '3.75',
        width: '13.5',
        height: '16.5',
        rx: '2.25',
      },
    ],
    [
      'path',
      {
        d: 'M8.75 8.25h6.5M8.75 12h6.5M8.75 15.75h3.5',
      },
    ],
  ],
  payout: [
    [
      'path',
      {
        d: 'M3.75 12h12.5M12.5 7.75L16.75 12l-4.25 4.25',
      },
    ],
    [
      'circle',
      {
        cx: '19',
        cy: '12',
        r: '1.5',
      },
    ],
  ],
  recipient: [
    [
      'circle',
      {
        cx: '12',
        cy: '8.25',
        r: '3.75',
      },
    ],
    [
      'path',
      {
        d: 'M4.5 20.25c.75-3.75 3.75-6 7.5-6s6.75 2.25 7.5 6',
      },
    ],
  ],
  approval: [
    [
      'path',
      {
        d: 'M12 3.75l6.75 2.25v5.25c0 4.5-3 7.5-6.75 9-3.75-1.5-6.75-4.5-6.75-9V6z',
      },
    ],
    [
      'path',
      {
        d: 'M9 12l2.25 2.25L15 10.5',
      },
    ],
  ],
  receipt: [
    [
      'path',
      {
        d: 'M6 3.75h12v16.5l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5z',
      },
    ],
    [
      'path',
      {
        d: 'M9 8.25h6M9 12h6',
      },
    ],
  ],
  rail: [
    [
      'path',
      {
        d: 'M3.75 8.25h16.5M3.75 15.75h16.5',
      },
    ],
    [
      'path',
      {
        d: 'M7.5 6v12M12 6v12M16.5 6v12',
      },
    ],
  ],
  'local-currency': [
    [
      'circle',
      {
        cx: '12',
        cy: '12',
        r: '8.25',
      },
    ],
    [
      'path',
      {
        d: 'M3.75 12h16.5M12 3.75c2.25 2.25 3.25 5 3.25 8.25s-1 6-3.25 8.25c-2.25-2.25-3.25-5-3.25-8.25s1-6 3.25-8.25',
      },
    ],
  ],
  agent: [
    [
      'rect',
      {
        x: '5.25',
        y: '7.5',
        width: '13.5',
        height: '11.25',
        rx: '3',
      },
    ],
    [
      'path',
      {
        d: 'M12 4.5v3',
      },
    ],
    [
      'circle',
      {
        cx: '12',
        cy: '3.75',
        r: '.75',
      },
    ],
    [
      'path',
      {
        d: 'M9.5 12.5v1.5M14.5 12.5v1.5',
      },
    ],
  ],
  pause: [
    [
      'circle',
      {
        cx: '12',
        cy: '12',
        r: '8.25',
      },
    ],
    [
      'path',
      {
        d: 'M10 9v6M14 9v6',
      },
    ],
  ],
};
