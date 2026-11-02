// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one form two values are compared in, as the contracts' runner defines
// it. A vector writes a 32 byte value as a label or as hex, and an attester
// as a label, raw bytes or an account actor's key; before any comparison
// both sides are rewritten so every 32 byte value and every attester is 0x
// hex of the bytes it stands for. Labels and actor keys are pure functions
// of their names, so this needs neither the vector nor the chain.

import { bytesOf, ed25519PublicKey, hexOf, sha256, utf8 } from '../bytes.js';

import { isObject } from './json.js';
import type { Json } from './json.js';

/** A label #name is the SHA-256 of this prefix followed by the name. */
export const LABEL_PREFIX = 'UJIRA/TEST-ONLY/vector/';
/** An actor's key seed is the SHA-256 of this prefix followed by its name. */
export const ACTOR_PREFIX = 'ujira-test-actor:';

const NAME = /^[a-z][a-z0-9_]*$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX = /^0x(?:[0-9a-f]{2})*$/;

const BYTES32_KEYS: ReadonlySet<string> = new Set([
  'payout_id',
  'recipient_ref',
  'task_ref',
  'tenant_tag',
  'country_policy_hash',
  'salt',
]);
const BYTES32_MAPS: ReadonlySet<string> = new Set(['payouts', 'daily']);

type Ctx = 'plain' | 'bytes32' | 'attester';

export class CanonError extends Error {
  override readonly name = 'CanonError';
}

export function isName(text: string): boolean {
  return NAME.test(text);
}

export function isLabel(text: string): boolean {
  return text.startsWith('#') && isName(text.slice(1));
}

/** The 32 bytes a label stands for. */
export function labelBytes(label: string): Uint8Array {
  if (!isLabel(label)) throw new CanonError(`${JSON.stringify(label)} is not a label`);
  return sha256(utf8(LABEL_PREFIX + label.slice(1)));
}

/** The public key of the test key a label names where a key is expected. */
export function labelKey(label: string): Uint8Array {
  return ed25519PublicKey(labelBytes(label));
}

const actorKeys = new Map<string, Uint8Array>();

export function actorSeed(name: string): Uint8Array {
  return sha256(utf8(ACTOR_PREFIX + name));
}

/** The ed25519 key behind an account actor's address. */
export function actorKey(name: string): Uint8Array {
  let key = actorKeys.get(name);
  if (key === undefined) {
    key = ed25519PublicKey(actorSeed(name));
    actorKeys.set(name, key);
  }
  return key;
}

/** A 32 byte value written as a label or as 0x and 64 hex digits. */
export function bytes32Of(text: string): Uint8Array {
  if (text.startsWith('#')) return labelBytes(text);
  if (!HEX32.test(text)) throw new CanonError(`${JSON.stringify(text)} is not 32 bytes`);
  return bytesOf(text);
}

/** An attester as its key bytes: a label is a test key's public key, hex is itself. */
export function attesterBytes(value: Json): Uint8Array {
  if (typeof value === 'string') {
    if (isLabel(value)) return labelKey(value);
    if (HEX.test(value)) return bytesOf(value);
  }
  if (isObject(value) && Object.keys(value).length === 1) {
    const actor = value['account_key'];
    if (typeof actor === 'string') return actorKey(actor);
  }
  throw new CanonError(`${JSON.stringify(value)} is not an attester`);
}

export function canonKey(key: string): string {
  return hexOf(bytes32Of(key));
}

function ctxFor(key: string): Ctx {
  if (key === 'attester') return 'attester';
  return BYTES32_KEYS.has(key) ? 'bytes32' : 'plain';
}

function canonIn(value: Json, ctx: Ctx): Json {
  if (ctx === 'attester' && (typeof value === 'string' || isObject(value))) {
    return hexOf(attesterBytes(value));
  }
  if (typeof value === 'string') {
    if (ctx === 'bytes32') return hexOf(bytes32Of(value));
    // A label means 32 bytes wherever a key is not expected, so an ID in a
    // list canonicalises without knowing its field.
    return isLabel(value) ? hexOf(labelBytes(value)) : value;
  }
  if (Array.isArray(value)) return value.map((v) => canonIn(v, ctx));
  if (isObject(value)) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = BYTES32_MAPS.has(k) ? canonKeyedMap(v) : canonIn(v, ctxFor(k));
    }
    return out;
  }
  return value;
}

function canonKeyedMap(value: Json): Json {
  if (!isObject(value)) return canon(value);
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(value)) out[canonKey(k)] = canon(v);
  return out;
}

/** The canonical form of a value; throws on a label or hex that is malformed. */
export function canon(value: Json): Json {
  return canonIn(value, 'plain');
}

/** The canonical form, or the value as it is when it has none. */
export function canonOrRaw(value: Json): Json {
  try {
    return canon(value);
  } catch (error) {
    if (error instanceof CanonError) return value;
    throw error;
  }
}
