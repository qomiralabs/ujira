// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { equal, isObject, show } from './json.js';
import type { Json } from './json.js';

export interface Difference {
  readonly path: string;
  readonly left: string;
  readonly right: string;
}

/** The first path where two values differ, with both sides written out. */
export function firstDifference(a: Json, b: Json, path: string): Difference | undefined {
  if (isObject(a) && isObject(b)) {
    for (const [k, x] of Object.entries(a)) {
      const sub = `${path}.${k}`;
      if (!Object.hasOwn(b, k)) return { path: sub, left: show(x), right: 'nothing' };
      const d = firstDifference(x, b[k] ?? null, sub);
      if (d !== undefined) return d;
    }
    const extra = Object.keys(b).find((k) => !Object.hasOwn(a, k));
    return extra === undefined
      ? undefined
      : { path: `${path}.${extra}`, left: 'nothing', right: show(b[extra]) };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const sub = `${path}[${String(i)}]`;
      const x = a[i];
      const y = b[i];
      if (x === undefined) return { path: sub, left: 'nothing', right: show(y) };
      if (y === undefined) return { path: sub, left: show(x), right: 'nothing' };
      const d = firstDifference(x, y, sub);
      if (d !== undefined) return d;
    }
    return undefined;
  }
  return equal(a, b) ? undefined : { path, left: show(a), right: show(b) };
}
