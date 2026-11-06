// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The cursor a list hands out. It carries where the page ended, signed with a
// server key over the caller's tenant, the route and the filters, so a client can
// only hand back what it was given: an altered cursor, one from another tenant,
// and one reused with other filters are all INVALID_CURSOR.
//
// The text is the signature followed by the position, both base64url. The
// position is not secret, only unforgeable: it is a time and an id the caller
// has already been shown.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Tenant } from './auth.js';
import { ApiError } from './errors.js';

const DOMAIN = 'ujira.cursor.v1';
const MAC_BYTES = 32;
// The unpadded base64url length of the signature.
const MAC_TEXT = 43;
const MIN_KEY_BYTES = 32;
// The contract's own bound on a cursor.
const MAX_TEXT = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface CursorBinding {
  readonly tenant: Tenant;
  readonly route: string;
  /** The parsed query, without the cursor and the page size. */
  readonly query: Readonly<Record<string, unknown>>;
}

export interface CursorCodec {
  readonly encode: (binding: CursorBinding, position: unknown) => string;
  /** The position it was made with, or INVALID_CURSOR. */
  readonly decode: (binding: CursorBinding, cursor: string) => unknown;
}

// Keys sorted and absent filters dropped, so the same query always reads the
// same however it was written. Array order is kept: a list filter is a set, but
// a cursor promises the query exactly as it was.
function canonical(query: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

function invalid(): ApiError {
  return new ApiError('INVALID_CURSOR');
}

export function cursorCodec(key: Uint8Array): CursorCodec {
  if (key.byteLength < MIN_KEY_BYTES) {
    throw new RangeError('a cursor key is at least 32 bytes');
  }
  const signed = Buffer.from(key);
  const mac = (binding: CursorBinding, body: Buffer): Buffer =>
    createHmac('sha256', signed)
      .update(
        JSON.stringify([
          DOMAIN,
          binding.route,
          binding.tenant.principalId,
          binding.tenant.projectId,
          canonical(binding.query),
        ]),
      )
      .update('\n')
      .update(body)
      .digest();

  return {
    encode: (binding, position) => {
      const body = Buffer.from(JSON.stringify(position), 'utf8');
      const text = mac(binding, body).toString('base64url') + body.toString('base64url');
      // A position is a time and an id, far inside the bound; this would be a bug here.
      if (text.length > MAX_TEXT) throw new RangeError('a cursor position is too long');
      return text;
    },
    decode: (binding, cursor) => {
      if (cursor.length <= MAC_TEXT || cursor.length > MAX_TEXT || !BASE64URL.test(cursor)) {
        throw invalid();
      }
      const macText = cursor.slice(0, MAC_TEXT);
      const bodyText = cursor.slice(MAC_TEXT);
      const given = Buffer.from(macText, 'base64url');
      const body = Buffer.from(bodyText, 'base64url');
      // Decoding ignores the spare bits of a last character and skips what it
      // cannot read, so two texts can decode alike. Only the one this server
      // wrote is taken.
      if (
        given.byteLength !== MAC_BYTES ||
        given.toString('base64url') !== macText ||
        body.toString('base64url') !== bodyText
      ) {
        throw invalid();
      }
      if (!timingSafeEqual(given, mac(binding, body))) throw invalid();
      try {
        return JSON.parse(body.toString('utf8')) as unknown;
      } catch (error) {
        // Signed by this server, so only a bug here could make it unreadable.
        if (error instanceof SyntaxError) throw invalid();
        throw error;
      }
    },
  };
}
