// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Each caller of a signer service holds its own token from the secret
// manager, so a leaked token names the caller it came from and can be
// rotated alone. Only hashes are kept, every hash is compared in constant
// time, and no comparison stops early, so timing says nothing about which
// token came close.

import { createHash, timingSafeEqual } from 'node:crypto';

import { InvalidInputError } from '@ujira/chain-adapter';

export interface ServiceCaller {
  /** A short name for logs, such as payouts or adapter. */
  readonly name: string;
  /** At least 32 characters; never logged. */
  readonly token: string;
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const MIN_TOKEN = 32;
const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Who sent an Authorization header, or null for anyone else. */
export type Authenticate = (authorization: string | null) => string | null;

export function tokenAuthenticator(callers: readonly ServiceCaller[]): Authenticate {
  if (callers.length === 0) throw new InvalidInputError({ issues: ['callers (empty)'] });
  const known = callers.map((caller, index) => {
    if (!NAME.test(caller.name)) {
      throw new InvalidInputError({ issues: [`callers.${String(index)}.name (invalid)`] });
    }
    if (typeof caller.token !== 'string' || caller.token.length < MIN_TOKEN) {
      throw new InvalidInputError({ issues: [`callers.${String(index)}.token (too_short)`] });
    }
    return { name: caller.name, hash: digest(caller.token) };
  });
  if (new Set(known.map((k) => k.hash.toString('hex'))).size !== known.length) {
    throw new InvalidInputError({ issues: ['callers (duplicate_token)'] });
  }
  return (authorization) => {
    const match = authorization === null ? null : BEARER.exec(authorization);
    const presented = digest(match?.[1] ?? '');
    let found: string | null = null;
    for (const caller of known) {
      if (timingSafeEqual(caller.hash, presented) && match !== null) found = caller.name;
    }
    return found;
  };
}
