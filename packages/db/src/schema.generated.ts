// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from the migrations by `pnpm --filter @ujira/db db:types`.
// Do not edit by hand: CI regenerates this file and fails if it differs.

import type { ColumnType } from 'kysely';

export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Json = JsonValue;

export type JsonArray = JsonValue[];

export interface JsonObject {
  [x: string]: JsonValue | undefined;
}

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export type Numeric = ColumnType<string, number | string, number | string>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface OpsChainCursors {
  cursor: string;
  network: string;
  updated_at: Generated<Timestamp>;
}

export interface OpsExecutorAccounts {
  account_ref: string;
  lease_expires_at: Timestamp | null;
  lease_holder: string | null;
  network: string;
  next_sequence: Generated<Int8>;
}

export interface OpsFeeEstimates {
  computed_at: Generated<Timestamp>;
  leg_count: Int8;
  network: string;
  op: string;
  p95_inclusion_fee_stroops: Int8;
  p95_rent_stroops: Int8;
  p95_resource_fee_stroops: Int8;
  sample_count: Int8;
  window_end: Timestamp;
  window_start: Timestamp;
}

export interface OpsIdentityProviderEvents {
  event_key: string;
  provider: string;
  provider_account: string;
  raw_sha256: Buffer;
  received_at: Generated<Timestamp>;
}

export interface OpsRoutingConfigActive {
  only_row: Generated<boolean>;
  updated_at: Generated<Timestamp>;
  version: Int8;
}

export interface OpsRoutingConfigVersions {
  created_at: Generated<Timestamp>;
  created_by: string;
  document: Json;
  version: Generated<Int8>;
}

export interface OpsSigningKeys {
  account: string | null;
  anchor_id: string | null;
  created_at: Generated<Timestamp>;
  id: Generated<Int8>;
  key_ref: string;
  network: string | null;
  provider: string;
  public_key: Buffer | null;
  purpose: string;
  status: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface UjiraApiTokens {
  created_at: Generated<Timestamp>;
  expires_at: Timestamp | null;
  id: Generated<string>;
  prefix: string;
  principal_id: string;
  project_id: string;
  revoked_at: Timestamp | null;
  scopes: Generated<string[]>;
  secret_sha256: Buffer;
}

export interface UjiraAuditHeads {
  last_hash: Buffer;
  last_seq: Generated<Int8>;
  principal_id: string;
}

export interface UjiraAuditLog {
  action: string;
  actor_id: string | null;
  actor_kind: string;
  id: Generated<string>;
  metadata: Generated<Json>;
  occurred_at: Generated<Timestamp>;
  prev_hash: Buffer;
  principal_id: string;
  project_id: string;
  row_hash: Buffer;
  seq: Int8;
}

export interface UjiraAuditMetadataKeys {
  key: string;
}

export interface UjiraChainEvents {
  chain: string;
  created_at: Generated<Timestamp>;
  event_index: Int8;
  event_type: string;
  finalized_at: Timestamp;
  id: Generated<string>;
  ledger: Int8;
  mandate_instance_id: string;
  payload: Json;
  principal_id: string;
  project_id: string;
  tx_hash: Buffer;
}

export interface UjiraChains {
  code: string;
}

export interface UjiraCurrencies {
  code: string;
  minor_units: number;
}

export interface UjiraCurrencyScales {
  currency: string;
  scale: number;
}

export interface UjiraDeposits {
  amount: Numeric;
  asset: string;
  chain: string;
  chain_event_id: string;
  created_at: Generated<Timestamp>;
  from_address: string;
  funding_source_id: string | null;
  id: Generated<string>;
  mandate_instance_id: string;
  principal_id: string;
  project_id: string;
  scale: number;
}

export interface UjiraFundingSources {
  config: Generated<Json>;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  kind: string;
  mandate_instance_id: string;
  principal_id: string;
  project_id: string;
}

export interface UjiraFundingSweeps {
  amount: Numeric;
  asset: string;
  chain: string;
  created_at: Generated<Timestamp>;
  deposit_operation_id: string;
  failed_ledger: Int8 | null;
  funding_source_id: string;
  id: Generated<string>;
  mandate_instance_id: string;
  principal_id: string;
  project_id: string;
  scale: number;
  status: Generated<string>;
  sweep_tx_hash: Buffer | null;
  sweep_valid_until: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

export interface UjiraJobsWorkerHeartbeats {
  last_seen_at: Generated<Timestamp>;
  started_at: Generated<Timestamp>;
  worker_id: string;
}

export interface UjiraLedgerAccounts {
  asset: string;
  balance: Generated<Numeric>;
  chain: string;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  kind: string;
  last_seq: Generated<Int8>;
  mandate_instance_id: string;
  principal_id: string;
  project_id: string;
  scale: number;
}

export interface UjiraLedgerEntries {
  account_id: string;
  account_seq: Int8;
  amount: Numeric;
  balance_after: Numeric;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  journal_id: string;
  principal_id: string;
  project_id: string;
}

export interface UjiraLedgerJournals {
  chain_event_id: string | null;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  mandate_instance_id: string;
  principal_id: string;
  project_id: string;
  reverses_journal_id: string | null;
}

export interface UjiraLedgerReconciliation {
  ledger: Int8 | null;
  ledger_balance: Numeric | null;
  ledger_committed: Numeric | null;
  ledger_pending: Numeric | null;
  ledger_spent: Numeric | null;
  mandate_instance_id: string | null;
  matches: boolean | null;
  principal_id: string | null;
  project_id: string | null;
  state_balance: Numeric | null;
  state_committed: Numeric | null;
  state_pending: Numeric | null;
  state_spent: Numeric | null;
  taken_at: Timestamp | null;
}

export interface UjiraManagedSigners {
  address: string;
  agent_id: string;
  consented_by_member_id: string;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  key_ref: string;
  network: string;
  principal_id: string;
  project_id: string;
  status: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface UjiraMandateInstanceRoles {
  address: string;
  granted_event_id: string;
  mandate_instance_id: string;
  principal_id: string;
  project_id: string;
  revoked_event_id: string | null;
  role: string;
  updated_at: Generated<Timestamp>;
}

export interface UjiraMandateInstances {
  asset: string;
  attester_public_key: Buffer | null;
  chain: string;
  contract_address: string;
  country_policy_hash: Buffer | null;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  mandate_id: string;
  principal_id: string;
  project_id: string;
  scale: number;
  spec_version: string;
}

export interface UjiraMandates {
  country_policy_list: Generated<string[]>;
  country_policy_mode: Generated<string>;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  name: string;
  principal_id: string;
  project_id: string;
  updated_at: Generated<Timestamp>;
}

export interface UjiraMandateStateSnapshots {
  balance: Numeric;
  committed: Numeric;
  id: Generated<string>;
  ledger: Int8;
  mandate_instance_id: string;
  pending: Numeric;
  principal_id: string;
  project_id: string;
  spent: Numeric;
  taken_at: Generated<Timestamp>;
}

export interface UjiraMigrations {
  id: Generated<number>;
  name: string;
  run_on: Timestamp;
}

export interface UjiraPayoutMethods {
  chain: string;
  created_at: Generated<Timestamp>;
  destination_address: string;
  destination_tag: Numeric | null;
  details_ciphertext: Buffer | null;
  details_nonce: Buffer | null;
  has_tag: Generated<boolean>;
  id: Generated<string>;
  method: string;
  principal_id: string;
  project_id: string;
  rail: string;
  recipient_id: string;
  status: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface UjiraPrincipalMembers {
  created_at: Generated<Timestamp>;
  principal_id: string;
  role: string;
  updated_at: Generated<Timestamp>;
  user_id: string;
}

export interface UjiraPrincipals {
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  name: string;
  reporting_time_zone: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface UjiraProjects {
  chain_fallback: Generated<string>;
  created_at: Generated<Timestamp>;
  funding_hold_max_seconds: Generated<Int8>;
  id: Generated<string>;
  name: string;
  principal_id: string;
  updated_at: Generated<Timestamp>;
}

export interface UjiraRecipientIdentities {
  assurance: Generated<string>;
  chain: string | null;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp | null;
  failure_reason: string | null;
  flow_ref: string | null;
  id: Generated<string>;
  last_checked_at: Timestamp | null;
  nullifier_hmac: Buffer | null;
  pending_session_expires_at: Timestamp | null;
  pending_session_id: string | null;
  pending_session_url: string | null;
  principal_id: string;
  project_id: string;
  provider: string;
  provider_account: string | null;
  provider_ref: string | null;
  provider_status: string | null;
  provider_subject: string | null;
  raw_sha256: Buffer | null;
  recipient_id: string;
  state: string;
  updated_at: Generated<Timestamp>;
}

export interface UjiraRecipientPii {
  ciphertext: Buffer;
  created_at: Generated<Timestamp>;
  nonce: Buffer;
  principal_id: string;
  project_id: string;
  recipient_id: string;
  updated_at: Generated<Timestamp>;
}

export interface UjiraRecipients {
  country: string;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  principal_id: string;
  project_id: string;
  recipient_ref: Buffer;
  status: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface UjiraSettlementTokens {
  asset: string;
  chain: string;
  display_scale: number;
  token_scale: number;
}

export interface UjiraStatusTransitions {
  from_status: string;
  machine: string;
  to_status: string;
}

export interface Schema {
  'ops.chain_cursors': OpsChainCursors;
  'ops.executor_accounts': OpsExecutorAccounts;
  'ops.fee_estimates': OpsFeeEstimates;
  'ops.identity_provider_events': OpsIdentityProviderEvents;
  'ops.routing_config_active': OpsRoutingConfigActive;
  'ops.routing_config_versions': OpsRoutingConfigVersions;
  'ops.signing_keys': OpsSigningKeys;
  'ujira_jobs.worker_heartbeats': UjiraJobsWorkerHeartbeats;
  ujira_migrations: UjiraMigrations;
  'ujira.api_tokens': UjiraApiTokens;
  'ujira.audit_heads': UjiraAuditHeads;
  'ujira.audit_log': UjiraAuditLog;
  'ujira.audit_metadata_keys': UjiraAuditMetadataKeys;
  'ujira.chain_events': UjiraChainEvents;
  'ujira.chains': UjiraChains;
  'ujira.currencies': UjiraCurrencies;
  'ujira.currency_scales': UjiraCurrencyScales;
  'ujira.deposits': UjiraDeposits;
  'ujira.funding_sources': UjiraFundingSources;
  'ujira.funding_sweeps': UjiraFundingSweeps;
  'ujira.ledger_accounts': UjiraLedgerAccounts;
  'ujira.ledger_entries': UjiraLedgerEntries;
  'ujira.ledger_journals': UjiraLedgerJournals;
  'ujira.ledger_reconciliation': UjiraLedgerReconciliation;
  'ujira.managed_signers': UjiraManagedSigners;
  'ujira.mandate_instance_roles': UjiraMandateInstanceRoles;
  'ujira.mandate_instances': UjiraMandateInstances;
  'ujira.mandate_state_snapshots': UjiraMandateStateSnapshots;
  'ujira.mandates': UjiraMandates;
  'ujira.payout_methods': UjiraPayoutMethods;
  'ujira.principal_members': UjiraPrincipalMembers;
  'ujira.principals': UjiraPrincipals;
  'ujira.projects': UjiraProjects;
  'ujira.recipient_identities': UjiraRecipientIdentities;
  'ujira.recipient_pii': UjiraRecipientPii;
  'ujira.recipients': UjiraRecipients;
  'ujira.settlement_tokens': UjiraSettlementTokens;
  'ujira.status_transitions': UjiraStatusTransitions;
}
