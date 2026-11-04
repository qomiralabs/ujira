// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Repository methods for the evidence behind a destination and an attestation.
// As everywhere, no method takes a tenant id: visibility comes from the policies,
// and a new row takes its tenant from the transaction's context on the server.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

function tagOf(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function tagColumns(tag: bigint | null): { has_tag: boolean; tag: string | null } {
  return { has_tag: tag !== null, tag: tag === null ? null : tag.toString() };
}

export type EmbedSessionPurpose = 'onboarding' | 'method_change' | 'identity';

export interface NewEmbedSession {
  // 32 bytes. Only the hash of the token is ever stored.
  readonly tokenHash: Buffer;
  readonly tokenPrefix: string;
  readonly recipientId: string;
  readonly purpose: EmbedSessionPurpose;
  readonly allowedOrigins: readonly string[];
  readonly createdByToken: string | null;
  readonly expiresAt: Date;
}

export interface EmbedSession {
  readonly id: string;
  readonly tokenPrefix: string;
  readonly recipientId: string;
  readonly purpose: string;
  readonly allowedOrigins: readonly string[];
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

const embedSessionColumns = [
  'id',
  'token_prefix',
  'recipient_id',
  'purpose',
  'allowed_origins',
  'expires_at',
  'consumed_at',
] as const;

function toEmbedSession(row: {
  id: string;
  token_prefix: string;
  recipient_id: string;
  purpose: string;
  allowed_origins: string[];
  expires_at: Date;
  consumed_at: Date | null;
}): EmbedSession {
  return {
    id: row.id,
    tokenPrefix: row.token_prefix,
    recipientId: row.recipient_id,
    purpose: row.purpose,
    allowedOrigins: row.allowed_origins,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export const embedSessions = {
  create: async (db: Tx, input: NewEmbedSession): Promise<EmbedSession> => {
    const row = await db
      .insertInto('ujira.embed_sessions')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        token_hash: input.tokenHash,
        token_prefix: input.tokenPrefix,
        recipient_id: input.recipientId,
        purpose: input.purpose,
        allowed_origins: [...input.allowedOrigins],
        created_by_token: input.createdByToken,
        expires_at: input.expiresAt,
      })
      .returning(embedSessionColumns)
      .executeTakeFirstOrThrow();
    return toEmbedSession(row);
  },

  get: async (db: Tx, id: string): Promise<EmbedSession | undefined> => {
    const row = await db
      .selectFrom('ujira.embed_sessions')
      .select(embedSessionColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toEmbedSession(row);
  },
};

export type WalletChallengePurpose = 'payout_destination' | 'member_wallet' | 'agent_link';

export interface NewWalletChallenge {
  readonly methodId: string | null;
  readonly purpose: WalletChallengePurpose;
  readonly network: string;
  readonly address: string;
  readonly tag: bigint | null;
  readonly recipientRef: Buffer;
  readonly requestId: string;
  readonly nonceHash: Buffer;
  readonly messageHash: Buffer;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface WalletChallengeRow {
  readonly id: string;
  readonly methodId: string | null;
  readonly purpose: string;
  readonly network: string;
  readonly address: string;
  readonly tag: bigint | null;
  readonly recipientRef: Buffer;
  readonly requestId: string;
  readonly nonceHash: Buffer;
  readonly messageHash: Buffer;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

const challengeColumns = [
  'id',
  'method_id',
  'purpose',
  'network',
  'address',
  'tag',
  'recipient_ref',
  'request_id',
  'nonce_hash',
  'message_hash',
  'issued_at',
  'expires_at',
  'consumed_at',
] as const;

function toChallenge(row: {
  id: string;
  method_id: string | null;
  purpose: string;
  network: string;
  address: string;
  tag: string | null;
  recipient_ref: Buffer;
  request_id: string;
  nonce_hash: Buffer;
  message_hash: Buffer;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}): WalletChallengeRow {
  return {
    id: row.id,
    methodId: row.method_id,
    purpose: row.purpose,
    network: row.network,
    address: row.address,
    tag: tagOf(row.tag),
    recipientRef: row.recipient_ref,
    requestId: row.request_id,
    nonceHash: row.nonce_hash,
    messageHash: row.message_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export const walletChallenges = {
  // A nonce hash already issued is refused with 23505.
  create: async (db: Tx, input: NewWalletChallenge): Promise<WalletChallengeRow> => {
    const row = await db
      .insertInto('ujira.wallet_proof_challenges')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        method_id: input.methodId,
        purpose: input.purpose,
        network: input.network,
        address: input.address,
        ...tagColumns(input.tag),
        recipient_ref: input.recipientRef,
        request_id: input.requestId,
        nonce_hash: input.nonceHash,
        message_hash: input.messageHash,
        issued_at: input.issuedAt,
        expires_at: input.expiresAt,
      })
      .returning(challengeColumns)
      .executeTakeFirstOrThrow();
    return toChallenge(row);
  },

  get: async (db: Tx, id: string): Promise<WalletChallengeRow | undefined> => {
    const row = await db
      .selectFrom('ujira.wallet_proof_challenges')
      .select(challengeColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toChallenge(row);
  },

  // True for the one caller that consumed it, however many race for it.
  consume: async (db: Tx, id: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.wallet_proof_challenges')
      .set({ consumed_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('consumed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export type VerificationLevel =
  | 'wallet_signature'
  | 'wallet_session'
  | 'partner_confirmed'
  | 'forwarder_derived'
  | 'principal_asserted';

export interface NewDestinationVerification {
  readonly methodId: string;
  readonly level: VerificationLevel;
  readonly chain: string;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly scheme?: string | null;
  readonly challengeId?: string | null;
  readonly signature?: string | null;
  readonly signerKey?: string | null;
  readonly partnerRef?: string | null;
  readonly embedSessionId?: string | null;
  readonly derivedFrom?: string | null;
}

export interface DestinationVerification {
  readonly id: string;
  readonly methodId: string;
  readonly level: string;
  readonly chain: string;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly scheme: string | null;
  readonly challengeId: string | null;
  readonly signature: string | null;
  readonly signerKey: string | null;
  readonly partnerRef: string | null;
  readonly embedSessionId: string | null;
  readonly derivedFrom: string | null;
  readonly recordedAt: Date;
}

const verificationColumns = [
  'id',
  'method_id',
  'level',
  'chain',
  'destination_address',
  'destination_tag',
  'scheme',
  'challenge_id',
  'signature',
  'signer_key',
  'partner_ref',
  'embed_session_id',
  'derived_from',
  'recorded_at',
] as const;

function toVerification(row: {
  id: string;
  method_id: string;
  level: string;
  chain: string;
  destination_address: string;
  destination_tag: string | null;
  scheme: string | null;
  challenge_id: string | null;
  signature: string | null;
  signer_key: string | null;
  partner_ref: string | null;
  embed_session_id: string | null;
  derived_from: string | null;
  recorded_at: Date;
}): DestinationVerification {
  return {
    id: row.id,
    methodId: row.method_id,
    level: row.level,
    chain: row.chain,
    destinationAddress: row.destination_address,
    destinationTag: tagOf(row.destination_tag),
    scheme: row.scheme,
    challengeId: row.challenge_id,
    signature: row.signature,
    signerKey: row.signer_key,
    partnerRef: row.partner_ref,
    embedSessionId: row.embed_session_id,
    derivedFrom: row.derived_from,
    recordedAt: row.recorded_at,
  };
}

export const destinationVerifications = {
  record: async (db: Tx, input: NewDestinationVerification): Promise<DestinationVerification> => {
    const row = await db
      .insertInto('ujira.destination_verifications')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        method_id: input.methodId,
        level: input.level,
        chain: input.chain,
        destination_address: input.destinationAddress,
        has_tag: input.destinationTag !== null,
        destination_tag: input.destinationTag === null ? null : input.destinationTag.toString(),
        scheme: input.scheme ?? null,
        challenge_id: input.challengeId ?? null,
        signature: input.signature ?? null,
        signer_key: input.signerKey ?? null,
        partner_ref: input.partnerRef ?? null,
        embed_session_id: input.embedSessionId ?? null,
        derived_from: input.derivedFrom ?? null,
      })
      .returning(verificationColumns)
      .executeTakeFirstOrThrow();
    return toVerification(row);
  },

  get: async (db: Tx, id: string): Promise<DestinationVerification | undefined> => {
    const row = await db
      .selectFrom('ujira.destination_verifications')
      .select(verificationColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toVerification(row);
  },

  // The method's current evidence.
  latest: async (db: Tx, methodId: string): Promise<DestinationVerification | undefined> => {
    const row = await db
      .selectFrom('ujira.destination_verifications')
      .select(verificationColumns)
      .where('method_id', '=', methodId)
      .orderBy('recorded_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toVerification(row);
  },
};

export interface NewAttestation {
  readonly mandateInstanceId: string;
  readonly attemptId: string;
  readonly legIndex: number;
  readonly recipientId: string;
  readonly methodId: string;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly countryPolicyHash: Buffer;
  readonly policyEpoch: bigint;
  readonly validUntil: Date;
  readonly attesterKeyId: string;
  readonly digest: Buffer;
}

export interface Attestation {
  readonly id: string;
  readonly mandateInstanceId: string;
  readonly attemptId: string;
  readonly legIndex: number;
  readonly recipientId: string;
  readonly methodId: string;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly countryPolicyHash: Buffer;
  readonly policyEpoch: bigint;
  readonly validUntil: Date;
  readonly attesterKeyId: string;
  readonly digest: Buffer;
  readonly status: string;
  readonly signature: Buffer | null;
  readonly failureCode: string | null;
}

const attestationColumns = [
  'id',
  'mandate_instance_id',
  'attempt_id',
  'leg_index',
  'recipient_id',
  'method_id',
  'destination_address',
  'destination_tag',
  'country_policy_hash',
  'policy_epoch',
  'valid_until',
  'attester_key_id',
  'digest',
  'status',
  'signature',
  'failure_code',
] as const;

function toAttestation(row: {
  id: string;
  mandate_instance_id: string;
  attempt_id: string;
  leg_index: number;
  recipient_id: string;
  method_id: string;
  destination_address: string;
  destination_tag: string | null;
  country_policy_hash: Buffer;
  policy_epoch: string;
  valid_until: Date;
  attester_key_id: string;
  digest: Buffer;
  status: string;
  signature: Buffer | null;
  failure_code: string | null;
}): Attestation {
  return {
    id: row.id,
    mandateInstanceId: row.mandate_instance_id,
    attemptId: row.attempt_id,
    legIndex: row.leg_index,
    recipientId: row.recipient_id,
    methodId: row.method_id,
    destinationAddress: row.destination_address,
    destinationTag: tagOf(row.destination_tag),
    countryPolicyHash: row.country_policy_hash,
    policyEpoch: BigInt(row.policy_epoch),
    validUntil: row.valid_until,
    attesterKeyId: row.attester_key_id,
    digest: row.digest,
    status: row.status,
    signature: row.signature,
    failureCode: row.failure_code,
  };
}

export const attestations = {
  // The digest and key already logged are refused with 23505. Commit this before
  // asking the signer, which refuses a digest that is not pending.
  insertPending: async (db: Tx, input: NewAttestation): Promise<Attestation> => {
    const row = await db
      .insertInto('ujira.attestations')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: input.mandateInstanceId,
        attempt_id: input.attemptId,
        leg_index: input.legIndex,
        recipient_id: input.recipientId,
        method_id: input.methodId,
        destination_address: input.destinationAddress,
        has_tag: input.destinationTag !== null,
        destination_tag: input.destinationTag === null ? null : input.destinationTag.toString(),
        country_policy_hash: input.countryPolicyHash,
        policy_epoch: input.policyEpoch.toString(),
        valid_until: input.validUntil,
        attester_key_id: input.attesterKeyId,
        digest: input.digest,
      })
      .returning(attestationColumns)
      .executeTakeFirstOrThrow();
    return toAttestation(row);
  },

  get: async (db: Tx, id: string): Promise<Attestation | undefined> => {
    const row = await db
      .selectFrom('ujira.attestations')
      .select(attestationColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAttestation(row);
  },

  // True when it was still pending and is now signed.
  markSigned: async (db: Tx, id: string, signature: Buffer): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.attestations')
      .set({ status: 'signed', signature })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },

  // True when it was still pending and is now failed. The code is a code, never
  // a message.
  markFailed: async (db: Tx, id: string, failureCode: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.attestations')
      .set({ status: 'failed', failure_code: failureCode })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export type AgentLinkStatus = 'pending' | 'active' | 'revoked';

export interface NewAgentIdentityLink {
  readonly network: string;
  readonly address: string;
  readonly registry: string;
  // Up to 2^256 - 1.
  readonly tokenId: bigint;
  readonly displayName: string | null;
  readonly humanBackedUntil: Date | null;
}

export interface AgentIdentityLink {
  readonly id: string;
  readonly network: string;
  readonly address: string;
  readonly registry: string;
  readonly tokenId: bigint;
  readonly status: string;
  readonly humanBackedUntil: Date | null;
  readonly displayName: string | null;
  readonly lastCheckedAt: Date | null;
}

const agentLinkColumns = [
  'id',
  'network',
  'address',
  'registry',
  'token_id',
  'status',
  'human_backed_until',
  'display_name',
  'last_checked_at',
] as const;

function toAgentLink(row: {
  id: string;
  network: string;
  address: string;
  registry: string;
  token_id: string;
  status: string;
  human_backed_until: Date | null;
  display_name: string | null;
  last_checked_at: Date | null;
}): AgentIdentityLink {
  return {
    id: row.id,
    network: row.network,
    address: row.address,
    registry: row.registry,
    tokenId: BigInt(row.token_id),
    status: row.status,
    humanBackedUntil: row.human_backed_until,
    displayName: row.display_name,
    lastCheckedAt: row.last_checked_at,
  };
}

export const agentIdentityLinks = {
  // The same wallet and registry twice in a project is refused with 23505.
  create: async (db: Tx, input: NewAgentIdentityLink): Promise<AgentIdentityLink> => {
    const row = await db
      .insertInto('ujira.agent_identity_links')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        network: input.network,
        address: input.address,
        registry: input.registry,
        token_id: input.tokenId.toString(),
        display_name: input.displayName,
        human_backed_until: input.humanBackedUntil,
      })
      .returning(agentLinkColumns)
      .executeTakeFirstOrThrow();
    return toAgentLink(row);
  },

  get: async (db: Tx, id: string): Promise<AgentIdentityLink | undefined> => {
    const row = await db
      .selectFrom('ujira.agent_identity_links')
      .select(agentLinkColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toAgentLink(row);
  },

  setStatus: async (db: Tx, id: string, status: AgentLinkStatus): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.agent_identity_links')
      .set({ status, last_checked_at: sql<Date>`now()` })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export const identityEvidenceRepositories = {
  embedSessions,
  walletChallenges,
  destinationVerifications,
  attestations,
  agentIdentityLinks,
} as const;
