// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The routing document: which rails exist, which corridors they serve and in
// what order of preference, and the settings of every network. The rails
// and corridors sections are chain agnostic and validated here; the networks
// section belongs to the chain adapter, which validates it, so nothing in
// this package learns what a network's settings look like.
//
// Every string field is a constrained name, code or enum, so there is no
// free text a credential could hide in. The one place a secret is needed
// (an RPC endpoint) takes a secret reference, enforced by the adapter.

import { PayoutMethod } from '@ujira/api-schema';
import {
  InvalidInputError,
  isNetworkId,
  isRailId,
  parseNetworksConfig,
} from '@ujira/chain-adapter';
import type { NetworkId, NetworksConfig, RailId } from '@ujira/chain-adapter';
import { isFiatCurrencyCode, isTokenAsset } from '@ujira/core';
import type { FiatCurrencyCode, TokenAsset } from '@ujira/core';
import { z } from 'zod';

import { RoutingConfigInvalidError } from './errors.js';

export const ROUTING_SCHEMA_VERSION = 1;

export const ROUTING_STRATEGIES = Object.freeze(['priority', 'cheapest'] as const);
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

const MAX_RAILS = 256;
const MAX_CORRIDORS = 4096;
const MAX_CANDIDATES = 16;
const MAX_PRIORITY = 1000;
const MAX_ISSUES = 20;
const MAX_DEPTH = 32;

const name = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);

const networkId = z.string().refine((value): value is NetworkId => isNetworkId(value), {
  message: 'unknown_network',
});

const railKind = z.string().refine((value): value is RailId => isRailId(value), {
  message: 'unknown_rail_kind',
});

const deliveryCurrency = z
  .string()
  .refine(
    (value): value is FiatCurrencyCode | TokenAsset =>
      isFiatCurrencyCode(value) || isTokenAsset(value),
    { message: 'unknown_currency' },
  );

const rail = z.strictObject({
  /** The name corridors use to refer to this rail. */
  id: name,
  network: networkId,
  rail: railKind,
  /** The business behind the rail, such as an anchor. Absent when UJIRA delivers itself. */
  provider: name.optional(),
  enabled: z.boolean(),
});

const candidate = z.strictObject({
  rail: name,
  /** Lower is preferred. Ties are broken by the order of the list. */
  priority: z.int().min(0).max(MAX_PRIORITY),
});

const corridor = z.strictObject({
  /** ISO 3166-1 alpha-2. */
  country: z.string().regex(/^[A-Z]{2}$/),
  method: PayoutMethod,
  currency: deliveryCurrency,
  enabled: z.boolean(),
  strategy: z.enum(ROUTING_STRATEGIES),
  candidates: z.array(candidate).min(1).max(MAX_CANDIDATES),
});

/** The rails and corridors sections, and the version marker. Networks are validated apart. */
const routingSchema = z.strictObject({
  schemaVersion: z.literal(ROUTING_SCHEMA_VERSION),
  // Missing or not, the adapter reports on this section, so it is not reported twice.
  networks: z.unknown().optional(),
  rails: z.array(rail).min(1).max(MAX_RAILS),
  corridors: z.array(corridor).max(MAX_CORRIDORS),
});

type RoutingSections = z.output<typeof routingSchema>;

export type RailConfig = Readonly<z.output<typeof rail>>;
export type CorridorCandidate = Readonly<z.output<typeof candidate>>;
export type CorridorConfig = Readonly<
  Omit<z.output<typeof corridor>, 'candidates'> & {
    readonly candidates: readonly CorridorCandidate[];
  }
>;

/** A validated, frozen routing document. */
export interface RoutingConfig {
  readonly schemaVersion: typeof ROUTING_SCHEMA_VERSION;
  readonly networks: NetworksConfig;
  readonly rails: readonly RailConfig[];
  readonly corridors: readonly CorridorConfig[];
}

// Documents are stored as JSON, so anything JSON cannot hold is refused at
// write time instead of being silently changed by the round trip. Getters
// and prototypes are refused too: the schema reads fields by plain property
// access, and a getter could answer one way here and another way later.
function isJsonData(value: unknown, depth: number): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  const inArray = Array.isArray(value);
  if (inArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (inArray && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
      return false;
    }
    if (!isJsonData(descriptor.value, depth + 1)) return false;
  }
  return true;
}

// Paths hold only declared keys and array indexes, because every object in
// these sections is strict: an unknown key is reported on its parent. So a
// path can never echo text from the document.
function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.');
  const reason = issue.code === 'custom' ? issue.message : issue.code;
  return `${path === '' ? 'document' : path} (${reason})`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function networkIssues(input: unknown): {
  networks?: NetworksConfig;
  issues: readonly string[];
} {
  try {
    return { networks: parseNetworksConfig(input), issues: [] };
  } catch (err) {
    // The adapter reports paths and codes only, already under "networks".
    if (err instanceof InvalidInputError) return { issues: err.issues };
    throw err;
  }
}

/**
 * Validates a routing document and returns a frozen snapshot. Throws
 * RoutingConfigInvalidError listing what is wrong and where; values are
 * never quoted, so a secret pasted into the wrong field stays out of logs.
 */
export function parseRoutingConfig(input: unknown): RoutingConfig {
  if (!isJsonData(input, 0)) {
    throw new RoutingConfigInvalidError(['document (not_json)']);
  }
  const sections = routingSchema.safeParse(input);
  const issues: string[] = sections.success ? [] : sections.error.issues.map(formatIssue);
  const raw: unknown =
    typeof input === 'object' && input !== null ? Reflect.get(input, 'networks') : undefined;
  const parsed = networkIssues(raw);
  issues.push(...parsed.issues);
  const { networks } = parsed;
  // References are checked only once every field is well formed, so one
  // mistyped rail name is reported once and not again at every use of it.
  if (sections.success && networks !== undefined) {
    issues.push(...referenceIssues(sections.data, networks));
  }
  if (!sections.success || networks === undefined || issues.length > 0) {
    throw new RoutingConfigInvalidError(issues.slice(0, MAX_ISSUES));
  }
  const { schemaVersion, rails, corridors } = sections.data;
  return deepFreeze({ schemaVersion, networks, rails, corridors });
}

function referenceIssues(sections: RoutingSections, networks: NetworksConfig): string[] {
  const issues: string[] = [];
  const railIds = new Set<string>();
  for (const [index, entry] of sections.rails.entries()) {
    if (railIds.has(entry.id)) issues.push(`rails.${String(index)}.id (duplicate_rail)`);
    railIds.add(entry.id);
    // A rail on a network the document does not configure could never be
    // served. A configured network that is switched off is fine: turning a
    // network off must not mean editing every rail on it.
    if (!Object.hasOwn(networks, entry.network)) {
      issues.push(`rails.${String(index)}.network (network_not_configured)`);
    }
  }
  const corridorKeys = new Set<string>();
  for (const [index, entry] of sections.corridors.entries()) {
    const key = JSON.stringify([entry.country, entry.method, entry.currency]);
    if (corridorKeys.has(key)) issues.push(`corridors.${String(index)} (duplicate_corridor)`);
    corridorKeys.add(key);
    const named = new Set<string>();
    for (const [position, choice] of entry.candidates.entries()) {
      const path = `corridors.${String(index)}.candidates.${String(position)}.rail`;
      if (!railIds.has(choice.rail)) issues.push(`${path} (unknown_rail)`);
      else if (named.has(choice.rail)) issues.push(`${path} (duplicate_candidate)`);
      named.add(choice.rail);
    }
  }
  return issues;
}
