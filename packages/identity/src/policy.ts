// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate stores only a hash of the principal's country list, so the
// list kept off chain must hash to exactly what the mandate was given. The
// hash is SHA-256 over the canonical form: each code once, sorted, joined
// with commas. Mandate creation must build the hash with this function too.

import { createHash } from 'node:crypto';

import type { Bytes32, CountryCode } from '@ujira/chain-adapter';

import type { CountryPolicy } from './types.js';

export function canonicalCountryList(countries: readonly CountryCode[]): string {
  return [...new Set(countries)].sort().join(',');
}

export function countryPolicyHash(countries: readonly CountryCode[]): Bytes32 {
  const digest = createHash('sha256').update(canonicalCountryList(countries), 'utf8').digest('hex');
  return `0x${digest}` as Bytes32;
}

export function countryAllowed(policy: CountryPolicy, country: CountryCode): boolean {
  const listed = policy.countries.includes(country);
  return policy.mode === 'allow' ? listed : !listed;
}
