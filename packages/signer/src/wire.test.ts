// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// toWire writes bigints and byte arrays as one key tagged objects and
// fromWire reads them back; text that is not JSON reads as undefined, and
// an object that only resembles a tag is left as it is.

import { describe, expect, it } from 'vitest';

import { fromWire, toWire } from './wire.js';

describe('the wire format', () => {
  it('round trips bigints and bytes, a Buffer included', () => {
    const value = {
      big: 2n ** 64n - 1n,
      negative: -5n,
      bytes: Uint8Array.of(0, 1, 255),
      buffer: Buffer.from('abc'),
      nested: [{ empty: new Uint8Array(0) }],
      plain: 'text',
    };
    expect(fromWire(toWire(value))).toEqual({
      ...value,
      buffer: Uint8Array.from(Buffer.from('abc')),
    });
  });

  it('leaves lookalikes and refuses text that is not JSON', () => {
    expect(fromWire('{"$bigint":"01"}')).toEqual({ $bigint: '01' });
    expect(fromWire('{"$bigint":"1","x":1}')).toEqual({ $bigint: '1', x: 1 });
    expect(fromWire('{"$bytes":"not base64!"}')).toEqual({ $bytes: 'not base64!' });
    expect(fromWire('[1]')).toEqual([1]);
    expect(fromWire('not json')).toBeUndefined();
  });
});
