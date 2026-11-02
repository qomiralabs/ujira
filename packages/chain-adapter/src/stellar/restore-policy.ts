// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How long each restored entry is kept alive. A restore brings an entry back
// with the network's minimum lifetime, so the entries every call needs, the
// mandate's instance and code and its balance in the asset, are extended to
// the same horizon the mandate keeps its own instance at. An open payout
// record is only worth keeping until it lapses, plus the day of margin the
// mandate gives it, and no further, since rent is paid per ledger. A
// tombstone is never extended: an archived tombstone still blocks its payout
// ID, and if it is ever needed again a restore costs only a fee.

/** The mandate's own instance horizon: 31 days of five second ledgers. */
export const INSTANCE_TTL_EXTEND_LEDGERS = 31 * 17_280;
/** Margin past a payout's expiry, the same one the mandate applies. */
export const RECORD_TTL_MARGIN_SECONDS = 86_400n;
export const STELLAR_LEDGER_SECONDS = 5n;

export type RestoredEntry =
  | { readonly kind: 'instance' | 'code' | 'asset_balance'; readonly key: string }
  | { readonly kind: 'open_record'; readonly key: string; readonly expiresAt: bigint }
  | { readonly kind: 'tombstone' | 'other'; readonly key: string };

export interface ExtensionGroup {
  /** Ledgers from now, as an extend operation takes them. */
  readonly extendTo: number;
  readonly keys: readonly string[];
}

export interface ExtensionPolicy {
  readonly nowSeconds: bigint;
  readonly instanceTtlExtendLedgers: number;
}

/**
 * One group per distinct target, since an extend operation moves every key in
 * its footprint to the same horizon. Entries that need nothing are left out.
 */
export function extensionPlan(
  entries: readonly RestoredEntry[],
  policy: ExtensionPolicy,
): readonly ExtensionGroup[] {
  const groups = new Map<number, string[]>();
  const add = (extendTo: number, key: string): void => {
    const keys = groups.get(extendTo) ?? [];
    keys.push(key);
    groups.set(extendTo, keys);
  };
  for (const entry of entries) {
    if (entry.kind === 'instance' || entry.kind === 'code' || entry.kind === 'asset_balance') {
      add(policy.instanceTtlExtendLedgers, entry.key);
    } else if (entry.kind === 'open_record') {
      const left = entry.expiresAt + RECORD_TTL_MARGIN_SECONDS - policy.nowSeconds;
      // Rounded up, so the record outlives its margin rather than falling a
      // ledger short of it.
      const ledgers = (left + STELLAR_LEDGER_SECONDS - 1n) / STELLAR_LEDGER_SECONDS;
      if (ledgers > 0n) add(Number(ledgers), entry.key);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([extendTo, keys]) => ({ extendTo, keys }));
}
