// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The eligibility decision as a pure function of what the store holds, so
// the attester can run exactly the same rules on the rows it has already
// read, and the table tests can cover every combination without a store.

import type { RailCapability, UnixSeconds } from '@ujira/chain-adapter';

import type { IdentityConfig } from './config.js';
import { ASSURANCE_LEVELS } from './types.js';
import type {
  Assurance,
  EligibilityRefusalReason,
  EligibilityResult,
  IdentityProviderName,
  IdentityRecord,
  IdentityStatus,
  MandateInstanceRecord,
  PayoutMethodRecord,
  ProjectIdentitySettings,
  RecipientMode,
  RecipientRecord,
  RecipientRequirement,
} from './types.js';

/** One verification a payout needs: which provider, for which account, at what assurance. */
export interface IdentityNeed {
  readonly provider: IdentityProviderName;
  /** Matched for per account providers (an anchor's SEP-12); null matches the provider's only row. */
  readonly providerAccount: string | null;
  readonly assurance: Assurance;
}

export interface EligibilityFacts {
  readonly instance: MandateInstanceRecord | null;
  readonly recipient: RecipientRecord | null;
  readonly method: PayoutMethodRecord | null;
  readonly rail: RailCapability | null;
  readonly settings: ProjectIdentitySettings;
  /** The recipient's verifications. Rows of any other recipient are ignored. */
  readonly identities: readonly IdentityRecord[];
  readonly config: IdentityConfig;
  readonly now: UnixSeconds;
}

const PROJECT_NEED: Readonly<Record<RecipientRequirement, IdentityNeed | null>> = {
  self_pre_kyc: { provider: 'self', providerAccount: null, assurance: 'document_zk' },
  principal_attested: { provider: 'principal', providerAccount: null, assurance: 'principal_kyc' },
  none: null,
};

const STATUS_REASON: Readonly<Record<IdentityStatus, EligibilityRefusalReason | null>> = {
  verified: null,
  pending: 'IDENTITY_PENDING',
  rejected: 'IDENTITY_REJECTED',
  expired: 'IDENTITY_EXPIRED',
  revoked: 'IDENTITY_REVOKED',
};

/**
 * The requirement that applies under a mandate. `none` is only honoured on
 * an allowlist mandate, where the principal bound every destination on chain;
 * under an attested mandate UJIRA's own signature vouches for the recipient,
 * so the default requirement applies instead.
 */
export function effectiveRequirement(
  setting: RecipientRequirement,
  mode: RecipientMode,
): RecipientRequirement {
  return setting === 'none' && mode !== 'allowlist' ? 'self_pre_kyc' : setting;
}

/**
 * Every verification the payout needs, the project's first. A rail that
 * declares recipient KYC adds its anchor's SEP-12 verification on top of the
 * project's own requirement.
 */
export function identityNeeds(
  requirement: RecipientRequirement,
  rail: RailCapability,
  method: PayoutMethodRecord,
): readonly IdentityNeed[] | null {
  const needs: IdentityNeed[] = [];
  const project = PROJECT_NEED[requirement];
  if (project !== null) needs.push(project);
  if (rail.requiresRecipientKyc) {
    // A KYC rail with no anchor on the method has nobody to have verified the
    // recipient, so the method cannot carry this payout.
    if (method.anchorId === null) return null;
    needs.push({ provider: 'sep12', providerAccount: method.anchorId, assurance: 'anchor_kyc' });
  }
  return needs;
}

function refuse(reason: EligibilityRefusalReason): EligibilityResult {
  return { eligible: false, reason };
}

function rowFor(
  need: IdentityNeed,
  recipient: RecipientRecord,
  rows: readonly IdentityRecord[],
): IdentityRecord | undefined {
  return rows.find(
    (row) =>
      row.recipientId === recipient.id &&
      row.provider === need.provider &&
      (need.providerAccount === null || row.providerAccount === need.providerAccount),
  );
}

/** Why the row does not satisfy the need, or null when it does. */
export function identityRefusal(
  need: IdentityNeed,
  row: IdentityRecord,
  now: UnixSeconds,
): EligibilityRefusalReason | null {
  const byStatus = STATUS_REASON[row.status];
  if (byStatus !== null) return byStatus;
  // A verified row past its expiry is expired whether or not a sweep has
  // updated its status yet.
  if (row.expiresAt !== null && row.expiresAt <= now) return 'IDENTITY_EXPIRED';
  if (row.assurance !== need.assurance) return 'IDENTITY_REQUIRED';
  return null;
}

function strongest(levels: readonly Assurance[]): Assurance {
  return ASSURANCE_LEVELS.find((level) => levels.includes(level)) ?? 'none';
}

function earliest(times: readonly (UnixSeconds | null)[]): UnixSeconds | null {
  let first: UnixSeconds | null = null;
  for (const time of times) {
    if (time !== null && (first === null || time < first)) first = time;
  }
  return first;
}

/**
 * Checks run in a fixed order: the mandate, the recipient, the method and
 * its rail, then each needed verification. The first failure decides the
 * reason, so a caller sees the same reason for the same rows every time.
 */
export function decideEligibility(facts: EligibilityFacts): EligibilityResult {
  const { instance, recipient, method, rail, config, now } = facts;
  if (instance?.status !== 'active') return refuse('MANDATE_INACTIVE');
  if (recipient?.status !== 'active') return refuse('RECIPIENT_INACTIVE');
  if (
    method?.status !== 'active' ||
    method.recipientId !== recipient.id ||
    method.network !== instance.mandate.network
  ) {
    return refuse('DESTINATION_NOT_BOUND');
  }
  if (rail?.enabled !== true) return refuse('RAIL_UNAVAILABLE');

  const requirement = effectiveRequirement(
    facts.settings.recipientRequirement,
    instance.recipientMode,
  );
  const needs = identityNeeds(requirement, rail, method);
  if (needs === null) return refuse('DESTINATION_NOT_BOUND');

  const used: IdentityRecord[] = [];
  for (const need of needs) {
    // A provider that is off only matters to a payout that needs it.
    if (!config.providers[need.provider].enabled) return refuse('PROVIDER_UNAVAILABLE');
    const row = rowFor(need, recipient, facts.identities);
    if (row === undefined) return refuse('IDENTITY_REQUIRED');
    const reason = identityRefusal(need, row, now);
    if (reason !== null) return refuse(reason);
    used.push(row);
  }

  return {
    eligible: true,
    assurance: strongest(used.map((row) => row.assurance)),
    expiresAt: earliest(used.map((row) => row.expiresAt)),
  };
}
