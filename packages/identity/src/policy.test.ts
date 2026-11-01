// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalCountryList, countryAllowed, countryPolicyHash } from './policy.js';
import { country } from './testing/index.js';

const NG = country('NG');
const GH = country('GH');
const KE = country('KE');
const ZA = country('ZA');

function sha256Hex(text: string): string {
  return `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

describe('country policy', () => {
  it('hashes the sorted, comma joined list with each code once', () => {
    expect(canonicalCountryList([NG, GH, KE, NG])).toBe('GH,KE,NG');
    expect(countryPolicyHash([NG, GH, KE])).toBe(sha256Hex('GH,KE,NG'));
    expect(countryPolicyHash([KE, NG, GH, GH])).toBe(countryPolicyHash([GH, KE, NG]));
    expect(countryPolicyHash([])).toBe(sha256Hex(''));
  });

  it('allow lists only the listed countries, deny lists everything else', () => {
    expect(countryAllowed({ mode: 'allow', countries: [NG, GH] }, NG)).toBe(true);
    expect(countryAllowed({ mode: 'allow', countries: [NG, GH] }, ZA)).toBe(false);
    expect(countryAllowed({ mode: 'deny', countries: [NG, GH] }, NG)).toBe(false);
    expect(countryAllowed({ mode: 'deny', countries: [NG, GH] }, ZA)).toBe(true);
  });
});
