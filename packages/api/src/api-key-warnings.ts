// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The expiry warnings: 30 and 7 days before a key stops, once each. One sweep finds
// the keys across tenants by id alone, and handles each under its own tenant.
//
// A warning is claimed, sent, then marked. Sending happens outside any transaction,
// because it is an external call. A process that dies after sending and before
// marking repeats that warning once its claim runs out: a warning sent twice costs
// a second email, and one lost costs someone a key that stops working.

import type { Tenant } from './auth.js';
import { errorNameOf, requestLog } from './log.js';
import type { Logger } from './log.js';

export const API_KEY_WARNING_THRESHOLDS = Object.freeze([30, 7] as const);
export type WarningThreshold = (typeof API_KEY_WARNING_THRESHOLDS)[number];

const DAY_MS = 86_400_000;
const PAGE = 200;
/** How long a claim stands before another sweep may take it over. */
export const WARNING_CLAIM_SECONDS = 600;
const NOTIFY_TIMEOUT_MS = 10_000;

export interface WarningTarget extends Tenant {
  readonly tokenId: string;
}

export interface WarnedKey {
  readonly prefix: string;
  readonly name: string | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface ApiKeyWarningRecords {
  /** Across tenants, by id. Nothing else about a key leaves its tenant's transaction. */
  readonly targets: (after: string | undefined, limit: number) => Promise<readonly WarningTarget[]>;
  readonly key: (target: WarningTarget) => Promise<WarnedKey | undefined>;
  /** True for the one sweep that may send this warning now. */
  readonly claim: (
    target: WarningTarget,
    thresholdDays: WarningThreshold,
    claimSeconds: number,
  ) => Promise<boolean>;
  /** Marks these as sent, so a key inside both windows is not warned twice. */
  readonly markNotified: (
    target: WarningTarget,
    thresholds: readonly WarningThreshold[],
  ) => Promise<void>;
}

export interface ApiKeyExpiryWarning extends WarningTarget {
  readonly prefix: string;
  readonly name: string | null;
  readonly expiresAt: Date;
  readonly thresholdDays: WarningThreshold;
}

/**
 * Sends the warning: an email to the project's owners and admins and the
 * `api_key.expiring` webhook event. It holds no secret and no address, only
 * what names the key.
 */
export type ApiKeyExpiryNotifier = (
  warning: ApiKeyExpiryWarning,
  signal: AbortSignal,
) => Promise<void>;

export interface ApiKeyWarningDeps {
  readonly records: ApiKeyWarningRecords;
  readonly notify: ApiKeyExpiryNotifier;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** How long a claim stands. Tests shorten it, rather than reach into the table. */
  readonly claimSeconds?: number;
}

export interface SweepResult {
  readonly sent: number;
  readonly failed: number;
}

// The tightest window a key is inside, and every window that one covers. A key
// made to last 5 days gets the 7 day warning alone, not both at once.
function dueThresholds(expiresAt: Date, now: Date): readonly WarningThreshold[] {
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return [];
  if (left <= 7 * DAY_MS) return [7, 30];
  if (left <= 30 * DAY_MS) return [30];
  return [];
}

export async function sendApiKeyExpiryWarnings(deps: ApiKeyWarningDeps): Promise<SweepResult> {
  const now = deps.now ?? (() => new Date());
  const log = requestLog(deps.logger, 'api_key_warning_sweep', now);
  const claimSeconds = deps.claimSeconds ?? WARNING_CLAIM_SECONDS;
  let sent = 0;
  let failed = 0;
  let after: string | undefined;
  for (;;) {
    const targets = await deps.records.targets(after, PAGE);
    for (const target of targets) {
      after = target.tokenId;
      const key = await deps.records.key(target);
      // Not there, or revoked since the sweep read its targets.
      if (key?.revokedAt !== null) continue;
      const [thresholdDays] = dueThresholds(key.expiresAt, now());
      if (thresholdDays === undefined) continue;
      if (!(await deps.records.claim(target, thresholdDays, claimSeconds))) continue;
      try {
        await deps.notify(
          {
            ...target,
            prefix: key.prefix,
            name: key.name,
            expiresAt: key.expiresAt,
            thresholdDays,
          },
          AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
        );
      } catch (error) {
        // One failed send must not hold up every other key. The claim runs out, and
        // a later sweep tries this one again.
        failed += 1;
        log.warn('api_key_warning_failed', {
          principalId: target.principalId,
          projectId: target.projectId,
          resourceId: target.tokenId,
          errorName: errorNameOf(error),
        });
        continue;
      }
      await deps.records.markNotified(target, dueThresholds(key.expiresAt, now()));
      sent += 1;
    }
    if (targets.length < PAGE) return { sent, failed };
  }
}
