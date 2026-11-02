// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Before UJIRA attests a destination, the recipient proves they control it
// by signing a challenge with the destination's key. The challenge text is
// the same on every chain; only the signing scheme differs, and that lives
// with each chain's code. The text binds the host that asked, the address,
// what the proof is for, the network, a single use nonce, a short validity
// window, the request and the recipient and tag being attested, so a
// signature made for one of them can never be replayed for another.

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { InvalidInputError } from './errors.js';
import { isNetworkId } from './networks.js';
import type { NetworkId } from './networks.js';

export const WALLET_PROOF_PURPOSES = Object.freeze([
  'payout_destination',
  'member_wallet',
  'agent_link',
] as const);
export type WalletProofPurpose = (typeof WALLET_PROOF_PURPOSES)[number];

export const WALLET_PROOF_VERSION = 1;
export const DEFAULT_WALLET_PROOF_TTL_SECONDS = 300;
export const MAX_WALLET_PROOF_TTL_SECONDS = 900;

// What the person is agreeing to, in the words a wallet shows them.
const PURPOSE_LINES: Readonly<Record<WalletProofPurpose, string>> = Object.freeze({
  payout_destination: 'Confirm that UJIRA may send your payouts to this address.',
  member_wallet: 'Confirm that this wallet is yours to use as a mandate member on UJIRA.',
  agent_link: 'Confirm that this wallet may be linked to an agent on UJIRA.',
});

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isHostName(host: string): boolean {
  const labels = host.split('.');
  return host.length <= 253 && labels.length >= 2 && labels.every((l) => HOST_LABEL.test(l));
}

/**
 * The public section of the configuration: values that are safe to show to
 * anyone. The widget host is the one place a challenge's host comes from,
 * app.ujira.co in production and app.sandbox.ujira.co in the sandbox, so a
 * forged Host header on the request that asked for the challenge can never
 * put another site's name in front of the person signing.
 */
export const publicConfigSchema = z.strictObject({
  widgetHost: z.string().max(253).refine(isHostName, { message: 'a lowercase host name' }),
});
export type PublicConfig = Readonly<z.output<typeof publicConfigSchema>>;

function issuesOf(error: z.ZodError, root: string): string[] {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${[root, ...issue.path.map(String)].join('.')} (${issue.code})`);
}

/** Validates the public section. Issues name paths and codes only. */
export function parsePublicConfig(input: unknown): PublicConfig {
  const result = publicConfigSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidInputError({ issues: issuesOf(result.error, 'public') });
  }
  return Object.freeze(result.data);
}

// An address as the adapter parsed it. Every address form UJIRA reads is
// letters and digits, and anything else could break the line it sits on.
const ADDRESS = /^[A-Za-z0-9]{1,128}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const U64_MAX = 2n ** 64n - 1n;

const requestSchema = z.strictObject({
  network: z.custom<NetworkId>(isNetworkId),
  address: z.string().regex(ADDRESS),
  purpose: z.enum(WALLET_PROOF_PURPOSES),
  /** The recipient reference the attestation will carry, 0x and 64 hex. */
  recipientRef: z.string().regex(BYTES32),
  /** The destination tag the attestation will carry, or null for none. */
  tag: z.bigint().min(0n).max(U64_MAX).nullable(),
  requestId: z.uuid(),
  ttlSeconds: z.int().min(30).max(MAX_WALLET_PROOF_TTL_SECONDS).optional(),
});

export type WalletProofChallengeRequest = z.input<typeof requestSchema>;

/** A challenge as issued. Store it whole; verification compares against it. */
export interface WalletProofChallenge {
  readonly text: string;
  readonly network: NetworkId;
  readonly address: string;
  readonly purpose: WalletProofPurpose;
  readonly recipientRef: string;
  readonly tag: bigint | null;
  readonly requestId: string;
  readonly nonce: string;
  /** UTC, second precision, as the text states it. */
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type WalletProofInvalidReason =
  | 'BAD_SIGNATURE'
  | 'WRONG_SIGNER'
  | 'EXPIRED'
  | 'MESSAGE_MISMATCH'
  | 'UNSUPPORTED_ACCOUNT'
  | 'SIGNER_NOT_AUTHORIZED'
  | 'ACCOUNT_NOT_FOUND';

export type WalletProofResult =
  | {
      readonly status: 'valid';
      /** The signing scheme the network uses, as data. */
      readonly scheme: string;
      readonly signer: string;
    }
  | { readonly status: 'invalid'; readonly reason: WalletProofInvalidReason };

export interface VerifyWalletProofRequest {
  /** The challenge as issued and stored, never as the client sent it back. */
  readonly challenge: WalletProofChallenge;
  /** The text the wallet says it signed. */
  readonly signedText: string;
  /** The signature as the wallet returned it. */
  readonly signature: string;
  /**
   * The key the wallet reports signing with, for an account where an added
   * signer signs. Absent means the account's own key.
   */
  readonly signer?: string;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, upper case. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((buffer >> bits) & 31);
    }
  }
  if (bits > 0) out += BASE32.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/** 128 random bits as 26 base32 characters. */
export function walletProofNonce(): string {
  return base32(randomBytes(16));
}

export interface WalletProofDeps {
  /** Unix seconds, as the adapter clock gives them. */
  readonly nowSeconds: () => bigint;
  readonly nonce?: () => string;
}

const NONCE = /^[A-Z2-7]{26}$/;

function isoSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
}

/** The exact text the wallet shows and signs. */
export function walletProofText(
  host: string,
  challenge: Omit<WalletProofChallenge, 'text'>,
): string {
  return [
    `${host} wants you to prove you control this address:`,
    challenge.address,
    '',
    PURPOSE_LINES[challenge.purpose],
    '',
    `URI: https://${host}`,
    `Version: ${String(WALLET_PROOF_VERSION)}`,
    `Chain ID: ${challenge.network}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
    `Expiration Time: ${challenge.expiresAt}`,
    `Request ID: ${challenge.requestId}`,
    'Resources:',
    `- urn:ujira:recipient:${challenge.recipientRef}`,
    `- urn:ujira:tag:${challenge.tag === null ? 'none' : challenge.tag.toString()}`,
  ].join('\n');
}

/**
 * Builds a challenge for `req`. The host is taken from the public config
 * and nothing else; the request has no field that could carry one, and an
 * unknown field is refused rather than ignored. Throws InvalidInputError
 * naming paths and codes only.
 */
export function walletProofChallenge(
  req: WalletProofChallengeRequest,
  config: PublicConfig,
  deps: WalletProofDeps,
): WalletProofChallenge {
  const parsed = requestSchema.safeParse(req);
  if (!parsed.success) {
    throw new InvalidInputError({ issues: issuesOf(parsed.error, 'walletProof') });
  }
  const host = parsePublicConfig(config).widgetHost;
  const nonce = (deps.nonce ?? walletProofNonce)();
  if (!NONCE.test(nonce)) throw new InvalidInputError({ issues: ['walletProof.nonce (invalid)'] });
  const now = deps.nowSeconds();
  const { ttlSeconds = DEFAULT_WALLET_PROOF_TTL_SECONDS, ...fields } = parsed.data;
  const challenge = {
    ...fields,
    nonce,
    issuedAt: isoSeconds(now),
    expiresAt: isoSeconds(now + BigInt(ttlSeconds)),
  };
  return Object.freeze({ ...challenge, text: walletProofText(host, challenge) });
}

/** Unix seconds of a challenge timestamp, which has whole seconds only. */
export function challengeSeconds(iso: string): bigint {
  return BigInt(Date.parse(iso) / 1000);
}
