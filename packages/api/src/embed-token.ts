// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The two credentials the embed widget deals in. An embed token,
// `ujes_<env>_<secret><checksum>`, lets it touch one recipient for a short time. An
// invite secret, `ujei_<env>_<secret><checksum>`, is what an invite link carries, and
// is good for one exchange.
//
// Neither can be mistaken for an API key, whose format is its own, and the prefixes
// let one be refused in memory if it reaches the wrong kind of route. The secret is 52
// base32 characters, 256 random bits, and only its SHA-256 is stored.

import { randomBytes } from 'node:crypto';

import { base32, checksumOf, hashSecret } from './token.js';
import type { TokenEnvironment } from './token.js';

const SECRET_BYTES = 32;
const STORED_PREFIX_LENGTH = 8;

const FORMATS = Object.freeze({
  token: { lead: 'ujes', pattern: /^(ujes_(live|test))_([a-z2-7]{52})([a-z2-7]{7})$/ },
  invite: { lead: 'ujei', pattern: /^(ujei_(live|test))_([a-z2-7]{52})([a-z2-7]{7})$/ },
});

export type EmbedCredentialKind = keyof typeof FORMATS;

export interface IssuedEmbedCredential {
  /** The whole credential. Handed over once and never stored. */
  readonly text: string;
  /** The public part kept with the row, so a support log can name it. */
  readonly prefix: string;
  readonly secretSha256: Buffer;
}

export interface ParsedEmbedCredential {
  readonly environment: TokenEnvironment;
  readonly secretSha256: Buffer;
}

export function issueEmbedCredential(
  kind: EmbedCredentialKind,
  environment: TokenEnvironment,
): IssuedEmbedCredential {
  const secret = base32(randomBytes(SECRET_BYTES));
  const body = `${FORMATS[kind].lead}_${environment}_${secret}`;
  return {
    text: `${body}${checksumOf(body)}`,
    // Every row uses the token's lead, whichever it is, as the column's format says.
    prefix: `ujes_${environment}_${secret.slice(0, STORED_PREFIX_LENGTH)}`,
    secretSha256: hashSecret(secret),
  };
}

/** The parts of a well formed credential of this kind, or null. Touches nothing. */
export function parseEmbedCredential(
  kind: EmbedCredentialKind,
  text: string,
): ParsedEmbedCredential | null {
  const match = FORMATS[kind].pattern.exec(text);
  if (match === null) return null;
  const [, lead, environment, secret, checksum] = match;
  if (lead === undefined || secret === undefined || checksum === undefined) return null;
  if (checksumOf(`${lead}_${secret}`) !== checksum) return null;
  return { environment: environment as TokenEnvironment, secretSha256: hashSecret(secret) };
}

/** Whether this looks like one of the widget's credentials, not an API key. */
export function isEmbedCredential(text: string): boolean {
  return text.startsWith('ujes_') || text.startsWith('ujei_');
}
