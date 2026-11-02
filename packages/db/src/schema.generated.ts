// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from the migrations by `pnpm --filter @ujira/db db:types`.
// Do not edit by hand: CI regenerates this file and fails if it differs.

import type { ColumnType } from 'kysely';

export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

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

export interface UjiraMigrations {
  id: Generated<number>;
  name: string;
  run_on: Timestamp;
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
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  name: string;
  principal_id: string;
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
  ujira_migrations: UjiraMigrations;
  'ujira.api_tokens': UjiraApiTokens;
  'ujira.chains': UjiraChains;
  'ujira.currencies': UjiraCurrencies;
  'ujira.currency_scales': UjiraCurrencyScales;
  'ujira.principal_members': UjiraPrincipalMembers;
  'ujira.principals': UjiraPrincipals;
  'ujira.projects': UjiraProjects;
  'ujira.settlement_tokens': UjiraSettlementTokens;
  'ujira.status_transitions': UjiraStatusTransitions;
}
