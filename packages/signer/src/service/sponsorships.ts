// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The signer's view of the adapter's sponsorship ledger. There is one ledger, and
// this is the only reading of it, so the row the adapter reserved is the row the
// sponsor is asked about: the signer knows a transaction's hash, and the ledger is
// keyed on that hash with the network, so one network's reservation cannot pay for
// another's transaction.

import { reservationIdOf } from '@ujira/chain-adapter';
import type { SponsorshipLedger as AdapterSponsorshipLedger } from '@ujira/chain-adapter';

import type { SponsorshipLedger } from './ports.js';

/** Only a row still reserved answers. A settled or released one has paid for nothing new. */
export function sponsorshipsFromLedger(
  ledger: Pick<AdapterSponsorshipLedger, 'get'>,
): SponsorshipLedger {
  return {
    reserved: async (network, txHash) => {
      const row = await ledger.get(reservationIdOf(network, txHash));
      if (row?.state !== 'reserved') return null;
      return { intent: row.intent, tenant: row.scope, maxFeeStroops: row.maxFeeStroops };
    },
  };
}
