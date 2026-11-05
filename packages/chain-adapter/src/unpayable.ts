// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which addresses can never pay anyone out. The attester asks when it signs and
// onboarding asks when a destination is added, and they must agree, so the rule
// lives here where both can reach it.
//
// A tag or an M address changes nothing: it only tells an account's owner who a
// payment is for, and the money still lands on the account.

import { baseAddress, isZeroAddress } from './codecs/strkey.js';

/** Whether a payment to `address` could never reach anyone: all zeros, or on `neverPayable`. */
export function isUnpayableAddress(address: string, neverPayable: readonly string[]): boolean {
  const base = baseAddress(address);
  return isZeroAddress(base) || neverPayable.includes(base);
}

/**
 * What every mandate on a network settles through: its trusted factories, the
 * asset contract and that asset's issuer, where a transfer of the asset is
 * burned. A mandate's own address is not here, since no destination added at
 * onboarding belongs to one mandate.
 */
export function settlementAddressesOf(network: {
  readonly trustedFactories: { readonly '1': readonly string[] };
  readonly assets: { readonly USDC: { readonly sac: string; readonly issuer: string } };
}): readonly string[] {
  const { sac, issuer } = network.assets.USDC;
  return [...network.trustedFactories['1'], sac, issuer];
}
