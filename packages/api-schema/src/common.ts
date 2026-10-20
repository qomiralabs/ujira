// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

export const Uuid = z.uuid();

/** UTC timestamps only, so two clients never disagree on ordering. */
export const Timestamp = z.iso.datetime();

export const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 code');

/**
 * CAIP-2 ids of the networks payouts settle on. Kept in step with the chain
 * adapter's list by a test, because this package must not depend on the
 * adapter at runtime.
 */
export const NETWORK_IDS = Object.freeze(['stellar:pubnet', 'stellar:testnet'] as const);
export const NetworkId = z.enum(NETWORK_IDS);
export type NetworkId = z.infer<typeof NetworkId>;

/** Chain addresses stay opaque here; the adapter is the one that parses them. */
export const ChainAddress = z.string().min(1).max(128);

/** Lowercase hex transaction hash as the adapter normalises it. */
export const TxHash = z.string().regex(/^(0x)?[0-9a-f]{64}$/, 'a lowercase hex transaction hash');

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256 digest');

/**
 * Every tenant resource names its principal and project, so a response
 * that crosses tenants is visible in the data itself, not only in the query.
 */
export const tenantFields = {
  principalId: Uuid,
  projectId: Uuid,
} as const;

export const TenantScope = z.strictObject(tenantFields);
export type TenantScope = z.infer<typeof TenantScope>;

/** Display text for people and things, bounded so a row can never be megabytes. */
export const DisplayName = z.string().min(1).max(200);

/** Shown in place of an account or phone number; never the full value. */
export const MaskedDestination = z.string().min(1).max(32);
