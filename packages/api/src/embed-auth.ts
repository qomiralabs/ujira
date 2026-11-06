// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Authentication for the widget's own routes. An embed token works only here, only
// from an origin the session allows, and only until it lapses or is used up. Unknown,
// lapsed and used tokens all read the same to the caller.
//
// Nothing is cached, unlike an API key: erasing a recipient closes their sessions, and
// that has to take effect on the very next request.

import type { AuthFailureCode, CallOptions, Credentials, Tenant } from './auth.js';
import { parseEmbedCredential } from './embed-token.js';
import type { TokenEnvironment } from './token.js';

/** What the store knows about a token. The secret itself is never in it. */
export interface EmbedTokenLookup {
  readonly sessionId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly purpose: string;
  readonly allowedOrigins: readonly string[];
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface EmbedTokenStore {
  /** The token this hash names, whatever its tenant, or undefined. */
  readonly find: (secretSha256: Buffer, call: CallOptions) => Promise<EmbedTokenLookup | undefined>;
}

/** Who an embed token lets in. */
export interface EmbedCaller extends Tenant {
  readonly sessionId: string;
  readonly recipientId: string;
  readonly purpose: string;
  readonly expiresAt: Date;
}

export type EmbedAuthResult =
  | { readonly ok: true; readonly caller: EmbedCaller }
  | { readonly ok: false; readonly code: AuthFailureCode | 'EMBED_TOKEN_INVALID' };

export type AuthenticateEmbed = (
  credentials: Credentials,
  call: CallOptions,
) => Promise<EmbedAuthResult>;

/** What a server with no database answers, so no widget route can run as nobody. */
export const refuseAllEmbedTokens: AuthenticateEmbed = () =>
  Promise.resolve({ ok: false, code: 'EMBED_TOKEN_INVALID' });

const BEARER = /^Bearer ([\x21-\x7e]{1,256})$/;

export interface EmbedAuthOptions {
  readonly store: EmbedTokenStore;
  /** The one environment whose tokens this deployment accepts. */
  readonly environment: TokenEnvironment;
  readonly now?: () => Date;
}

export function createEmbedAuthenticator(options: EmbedAuthOptions): AuthenticateEmbed {
  const now = options.now ?? (() => new Date());
  return async (credentials, call) => {
    const presented = BEARER.exec(credentials.authorization ?? '')?.[1];
    const parsed = presented === undefined ? null : parseEmbedCredential('token', presented);
    if (parsed?.environment !== options.environment) {
      return { ok: false, code: 'EMBED_TOKEN_INVALID' };
    }
    const lookup = await options.store.find(parsed.secretSha256, call);
    if (lookup?.consumedAt !== null || lookup.expiresAt.getTime() <= now().getTime()) {
      return { ok: false, code: 'EMBED_TOKEN_INVALID' };
    }
    // A browser always says where it is. A request that does not is not the widget.
    if (credentials.origin === null || !lookup.allowedOrigins.includes(credentials.origin)) {
      return { ok: false, code: 'ORIGIN_NOT_ALLOWED' };
    }
    return {
      ok: true,
      caller: {
        principalId: lookup.principalId,
        projectId: lookup.projectId,
        sessionId: lookup.sessionId,
        recipientId: lookup.recipientId,
        purpose: lookup.purpose,
        expiresAt: lookup.expiresAt,
      },
    };
  };
}
