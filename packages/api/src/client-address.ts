// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which address a request came from, for limiting the routes that have no key.
//
// A forwarded header is only as honest as whoever wrote it, and a caller can send
// one themselves. A proxy appends the peer it saw, so the entries on the right are
// the ones the deployment's own proxies wrote and anything further left is the
// caller's. So nothing is believed unless a setting names the header and the hop,
// counted from the right, and the entry at that hop is the only one ever read.

import { isIP } from 'node:net';

export interface TrustedProxy {
  /** The header to read, by lower case name. */
  readonly header: string;
  /** Counted from the right: 1 is the last entry, the one the nearest proxy wrote. */
  readonly hop: number;
}

export interface RequestOrigin {
  readonly headers: Headers;
  /** The socket's peer. Absent when the request did not arrive over a socket. */
  readonly peer: string | undefined;
}

function dottedToGroups(dotted: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = dotted.split('.').map(Number);
  return `${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
}

// Only ever given text isIP has already accepted, so the shape is known. It
// exists because one address has many spellings, and each must not earn a bucket.
function ipv6Groups(address: string): readonly number[] {
  const tailStart = address.lastIndexOf(':') + 1;
  const tail = address.slice(tailStart);
  const text = tail.includes('.')
    ? `${address.slice(0, tailStart)}${dottedToGroups(tail)}`
    : address;
  const [before = '', after] = text.split('::');
  const left = before === '' ? [] : before.split(':');
  const right = after === undefined || after === '' ? [] : after.split(':');
  const zeros = after === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array.from({ length: zeros }, () => '0'), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
}

/**
 * The form an address is limited under, or null if this is not an address. IPv6 is
 * cut to its /64, because one customer usually holds a whole /64 and could otherwise
 * take a fresh bucket for every request. A scoped address is refused, because the
 * scope is free text and only means something on the machine that wrote it.
 */
export function normalizeAddress(text: string): string | null {
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6 || text.includes('%')) return null;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = ipv6Groups(text);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    // An IPv4 client on a dual stack socket is the same client as over IPv4.
    return [g >> 8, g & 255, h >> 8, h & 255].join('.');
  }
  return `${[a, b, c, d].map((group) => group.toString(16)).join(':')}::/64`;
}

/**
 * The address to limit this request under, or null if there is none to believe. The
 * caller limits null under one shared bucket, so sending junk cannot earn a fresh one.
 */
export function clientAddress(origin: RequestOrigin, proxy: TrustedProxy | null): string | null {
  if (proxy === null) return origin.peer === undefined ? null : normalizeAddress(origin.peer);
  const entries = origin.headers.get(proxy.header)?.split(',') ?? [];
  // A plain index, because at() would wrap round to an entry the caller wrote when
  // there are fewer entries than hops.
  const entry = entries[entries.length - proxy.hop];
  return entry === undefined ? null : normalizeAddress(entry.trim());
}
