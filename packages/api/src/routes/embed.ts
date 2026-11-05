// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The embed widget's routes. An integrator's server mints a token with its API key, or
// an invite link that the widget exchanges for one. Either way the token reaches only
// its own recipient, only from an allowed origin, for 30 minutes.

import {
  EmbedInviteCreated,
  EmbedInviteExchange,
  EmbedRecipient,
  EmbedSessionCreated,
  EmbedSessionRequest,
} from '@ujira/api-schema';
import { z } from 'zod';

import type { CallOptions, Tenant } from '../auth.js';
import type { EmbedTokenStore } from '../embed-auth.js';
import { issueEmbedCredential, parseEmbedCredential } from '../embed-token.js';
import { ApiError } from '../errors.js';
import { defineEmbedRoute, definePublicRoute, defineTenantRoute } from '../route.js';
import type { Route } from '../route.js';
import type { TokenEnvironment } from '../token.js';

export const EMBED_TOKEN_SECONDS = 30 * 60;
// Long enough for a person to open an emailed link, short enough that a forgotten one
// does not stay good.
export const EMBED_INVITE_SECONDS = 72 * 60 * 60;

export interface NewEmbedRow {
  readonly kind: 'token' | 'invite';
  readonly secretSha256: Buffer;
  readonly prefix: string;
  readonly recipientId: string;
  readonly purpose: 'onboarding';
  readonly allowedOrigins: readonly string[];
  /** The API key that made it. Null for an invite link. */
  readonly createdByToken: string | null;
  readonly expiresAt: Date;
}

export interface EmbedInviteSwap {
  readonly inviteSha256: Buffer;
  readonly tokenSha256: Buffer;
  readonly tokenPrefix: string;
  readonly tokenSeconds: number;
  readonly origin: string;
}

export interface EmbedStore extends EmbedTokenStore {
  readonly recipientExists: (
    tenant: Tenant,
    recipientId: string,
    call: CallOptions,
  ) => Promise<boolean>;
  readonly create: (tenant: Tenant, row: NewEmbedRow, call: CallOptions) => Promise<void>;
  /** Spends the invite and makes the token, or undefined when it cannot be spent. */
  readonly exchange: (
    swap: EmbedInviteSwap,
    call: CallOptions,
  ) => Promise<{ readonly expiresAt: Date } | undefined>;
}

export interface EmbedDependencies {
  readonly store: EmbedStore;
  readonly environment: TokenEnvironment;
  readonly now?: () => Date;
}

/** Stands in until a database is configured. Nothing can be minted or exchanged. */
export const EMBED_NOT_CONFIGURED: EmbedDependencies = Object.freeze({
  environment: 'test',
  store: Object.freeze({
    find: () => Promise.reject(new ApiError('DB_UNAVAILABLE')),
    recipientExists: () => Promise.reject(new ApiError('DB_UNAVAILABLE')),
    create: () => Promise.reject(new ApiError('DB_UNAVAILABLE')),
    exchange: () => Promise.reject(new ApiError('DB_UNAVAILABLE')),
  }),
});

const RecipientParams = z.strictObject({ id: z.uuid() });

export function embedRoutes(deps: EmbedDependencies): readonly Route[] {
  const { store, environment } = deps;
  const now = deps.now ?? (() => new Date());

  const mint = async (
    kind: 'token' | 'invite',
    tenant: Tenant,
    body: z.output<typeof EmbedSessionRequest>,
    createdByToken: string | null,
    seconds: number,
    call: CallOptions,
  ) => {
    // Under the caller's tenant, so another tenant's recipient reads as not there.
    if (!(await store.recipientExists(tenant, body.recipientId, call))) {
      throw new ApiError('NOT_FOUND');
    }
    const issued = issueEmbedCredential(kind, environment);
    const expiresAt = new Date(now().getTime() + seconds * 1000);
    await store.create(
      tenant,
      {
        kind,
        secretSha256: issued.secretSha256,
        prefix: issued.prefix,
        recipientId: body.recipientId,
        purpose: body.purpose,
        allowedOrigins: body.allowedOrigins,
        createdByToken,
        expiresAt,
      },
      call,
    );
    return { text: issued.text, expiresAt: expiresAt.toISOString() };
  };

  return Object.freeze([
    defineTenantRoute({
      id: 'createEmbedSession',
      method: 'POST',
      path: '/v1/embed/sessions',
      summary: 'Mint a short lived token for the widget to touch one recipient',
      scope: 'recipients:write',
      body: EmbedSessionRequest,
      response: { status: 201, name: 'EmbedSessionCreated', schema: EmbedSessionCreated },
      errors: ['NOT_FOUND'],
      handler: async ({ body }, context) => {
        const issued = await mint(
          'token',
          context.tenant,
          body,
          context.credentialId ?? null,
          EMBED_TOKEN_SECONDS,
          context.call,
        );
        return { embedToken: issued.text, expiresAt: issued.expiresAt };
      },
    }),
    defineTenantRoute({
      id: 'createEmbedInvite',
      method: 'POST',
      path: '/v1/embed/invites',
      summary: 'Make a single use invite the widget can exchange for a token',
      scope: 'recipients:write',
      body: EmbedSessionRequest,
      response: { status: 201, name: 'EmbedInviteCreated', schema: EmbedInviteCreated },
      errors: ['NOT_FOUND'],
      handler: async ({ body }, context) => {
        const issued = await mint(
          'invite',
          context.tenant,
          body,
          null,
          EMBED_INVITE_SECONDS,
          context.call,
        );
        return { inviteSecret: issued.text, expiresAt: issued.expiresAt };
      },
    }),
    definePublicRoute({
      id: 'exchangeEmbedInvite',
      method: 'POST',
      path: '/v1/embed/invites/exchange',
      summary: 'Exchange an invite secret for a token, once',
      reason: 'The widget has no key yet: the single use invite secret in the body stands in',
      browser: true,
      body: EmbedInviteExchange,
      response: { name: 'EmbedSessionCreated', schema: EmbedSessionCreated },
      errors: ['EMBED_TOKEN_INVALID', 'ORIGIN_NOT_ALLOWED'],
      handler: async ({ body }, context) => {
        // Every way this can fail reads the same, so it tells nothing about which
        // secrets exist.
        const invite = parseEmbedCredential('invite', body.inviteSecret);
        if (invite?.environment !== environment) throw new ApiError('EMBED_TOKEN_INVALID');
        if (context.origin === null) throw new ApiError('ORIGIN_NOT_ALLOWED');
        const issued = issueEmbedCredential('token', environment);
        const made = await store.exchange(
          {
            inviteSha256: invite.secretSha256,
            tokenSha256: issued.secretSha256,
            tokenPrefix: issued.prefix,
            tokenSeconds: EMBED_TOKEN_SECONDS,
            origin: context.origin,
          },
          context.call,
        );
        if (made === undefined) throw new ApiError('EMBED_TOKEN_INVALID');
        return { embedToken: issued.text, expiresAt: made.expiresAt.toISOString() };
      },
    }),
    defineEmbedRoute({
      id: 'getEmbedRecipient',
      method: 'GET',
      path: '/v1/embed/recipients/{id}',
      summary: 'The recipient an embed token was made for',
      params: RecipientParams,
      response: { name: 'EmbedRecipient', schema: EmbedRecipient },
      errors: ['NOT_FOUND'],
      handler: ({ params }, context) => {
        // The same answer as a recipient that does not exist, so a token cannot be
        // used to learn which ids are real.
        if (params.id !== context.embed.recipientId) {
          return Promise.reject(new ApiError('NOT_FOUND'));
        }
        return Promise.resolve({
          recipientId: context.embed.recipientId,
          purpose: context.embed.purpose,
          expiresAt: context.embed.expiresAt.toISOString(),
        });
      },
    }),
  ]);
}
