// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A small seeded generator (sfc32). Fixtures must come out the same on every
// machine and in every browser, so nothing here reads the clock or
// Math.random.

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed >>> 0;
    // Mixes the seed in before the first value is used.
    for (let i = 0; i < 15; i += 1) this.next();
  }

  /** The next 32 bit unsigned value. */
  next(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** A whole number from 0 up to, not including, `bound`. */
  below(bound: number): number {
    return this.next() % bound;
  }

  /** A whole number from `min` to `max`, both included. */
  between(min: number, max: number): number {
    return min + this.below(max - min + 1);
  }

  chance(percent: number): boolean {
    return this.below(100) < percent;
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.below(values.length)];
    if (value === undefined) throw new RangeError('cannot pick from an empty list');
    return value;
  }

  /** A bigint from `min` to `max`, both included. */
  bigBetween(min: bigint, max: bigint): bigint {
    const span = max - min + 1n;
    let value = 0n;
    // Enough random bits to cover the span, then reduced into it.
    for (let bits = 0n; 1n << bits < span * 2n; bits += 32n) {
      value = (value << 32n) | BigInt(this.next());
    }
    return min + (value % span);
  }

  hex(length: number): string {
    let out = '';
    while (out.length < length) out += this.next().toString(16).padStart(8, '0');
    return out.slice(0, length);
  }

  /** A version 4 shaped UUID. */
  uuid(): string {
    const h = this.hex(32);
    const variant = '89ab'[this.below(4)] ?? '8';
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}
