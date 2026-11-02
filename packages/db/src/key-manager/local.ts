// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The key manager for development, tests and CI: AES-256-GCM under keys held
// in process memory. That is fine for data that protects nothing and wrong
// for any that does, so it refuses to start in production.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { KeyManagerInputError, KeyManagerRefusedError, aadFields } from './port.js';
import type { KeyManager, KeyWrapAad, WrappedKey } from './port.js';

/** The variable the local key manager reads its keys from. */
export const LOCAL_KEK_VARIABLE = 'UJIRA_PII_LOCAL_KEK';

const ENTRY = /^([A-Za-z0-9_-]{1,64}):([0-9a-f]{64})$/;
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface LocalKeyManagerOptions {
  /**
   * One or more `id:hex` pairs joined by commas, 64 lower case hex characters
   * each, the current key first. Earlier keys stay listed so what they wrapped
   * keeps unwrapping after a rotation.
   */
  readonly keks: string;
  /** The deployment environment; process.env.NODE_ENV when left out. */
  readonly nodeEnv?: string | undefined;
}

interface ParsedKek {
  readonly id: string;
  readonly kek: Buffer;
}

// The value is never repeated in the message: it is a key.
function malformed(): KeyManagerInputError {
  return new KeyManagerInputError(`${LOCAL_KEK_VARIABLE} is not a list of id:hex keys`);
}

function parseEntry(entry: string): ParsedKek {
  const [, id, hex] = ENTRY.exec(entry) ?? [];
  if (id === undefined || hex === undefined) throw malformed();
  return { id, kek: Buffer.from(hex, 'hex') };
}

function aadBytes(aad: KeyWrapAad): Buffer {
  // Sorted, so one set of fields has one encoding.
  return Buffer.from(JSON.stringify(Object.entries(aadFields(aad)).sort()), 'utf8');
}

export class LocalKeyManager implements KeyManager {
  readonly currentKekId: string;
  readonly #keks: ReadonlyMap<string, Buffer>;
  readonly #currentKek: Buffer;

  constructor(options: LocalKeyManagerOptions) {
    if ((options.nodeEnv ?? process.env['NODE_ENV']) === 'production') {
      throw new KeyManagerInputError('The local key manager refuses to start in production');
    }
    const [first = '', ...rest] = options.keks.split(',');
    const { id, kek } = parseEntry(first);
    const keks = new Map<string, Buffer>([[id, kek]]);
    for (const entry of rest) {
      const other = parseEntry(entry);
      if (keks.has(other.id)) throw malformed();
      keks.set(other.id, other.kek);
    }
    this.currentKekId = id;
    this.#keks = keks;
    this.#currentKek = kek;
  }

  /** A key manager with its keys from UJIRA_PII_LOCAL_KEK. */
  static fromEnv(env: Readonly<Record<string, string | undefined>> = process.env): LocalKeyManager {
    return new LocalKeyManager({ keks: env[LOCAL_KEK_VARIABLE] ?? '', nodeEnv: env['NODE_ENV'] });
  }

  wrap(dek: Uint8Array, aad: KeyWrapAad): Promise<WrappedKey> {
    return Promise.resolve().then(() => {
      if (!(dek instanceof Uint8Array) || dek.length !== DEK_BYTES) {
        throw new KeyManagerInputError('A data key is 32 bytes');
      }
      const additional = aadBytes(aad);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.#currentKek, iv);
      cipher.setAAD(additional);
      const body = Buffer.concat([cipher.update(dek), cipher.final()]);
      return {
        wrapped: Uint8Array.from(Buffer.concat([iv, cipher.getAuthTag(), body])),
        kekId: this.currentKekId,
      };
    });
  }

  unwrap(wrapped: Uint8Array, kekId: string, aad: KeyWrapAad): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      const additional = aadBytes(aad);
      const kek = this.#keks.get(kekId);
      if (kek === undefined) throw new KeyManagerRefusedError();
      const bytes = Buffer.from(wrapped);
      try {
        const decipher = createDecipheriv('aes-256-gcm', kek, bytes.subarray(0, IV_BYTES));
        decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        decipher.setAAD(additional);
        return Uint8Array.from(
          Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]),
        );
      } catch {
        // A wrong key, wrong associated data or damaged bytes, which GCM
        // cannot tell apart and a caller should not be told about.
        throw new KeyManagerRefusedError();
      }
    });
  }
}
