// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for serializeAdapterError, the log serializer for errors that
 * pass through the adapter.
 *
 * An adapter error is logged as its class name, the fixed message for its
 * code, its job form and the kind of its cause. Fields come from the code
 * table, so a message or cause changed after construction never reaches a
 * log line. Any other value is logged as its class name only, from the
 * runtime's and this module's own names, and never its message, stack,
 * fields or cause. The serializer never throws.
 */

import { format, inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  ADAPTER_LOG_SERIALIZERS,
  ChainUnavailableError,
  InvalidInputError,
  MandateRuleError,
  RpcTimeoutError,
  serializeAdapterError,
} from './index.js';

// A provider URL with its key, the way a transport error quotes it. The
// marker is a plain word rather than a key shaped string, so the secret
// scan has nothing to flag and a search for it in output is unambiguous.
const SECRET = 'SUPERSECRETKEY123';
const SECRET_URL = `https://rpc.example/v3/${SECRET}`;

function transportError(): Error {
  const err = new TypeError(`fetch failed for ${SECRET_URL}`, {
    cause: new Error(`connect to ${SECRET_URL} refused`),
  });
  return Object.assign(err, { url: SECRET_URL, config: { headers: { authorization: SECRET } } });
}

function everyPrinting(value: unknown): string[] {
  return [
    JSON.stringify(value),
    inspect(value, { depth: Infinity, showHidden: true }),
    format('%o', value),
    format('%s', value),
  ];
}

describe('serializeAdapterError', () => {
  it('logs an adapter error built from a transport error without the secret', () => {
    const err = new ChainUnavailableError({ cause: transportError(), network: 'stellar:testnet' });
    const logged = serializeAdapterError(err);

    expect(logged).toEqual({
      name: 'ChainUnavailableError',
      message: err.message,
      error: err.toJSON(),
      cause: 'Cause redacted: TypeError',
    });
    for (const text of [...everyPrinting(logged), ...everyPrinting(err)]) {
      expect(text).not.toContain(SECRET);
    }
  });

  it('keeps the job form of each error class', () => {
    const invalid = new InvalidInputError({ issues: ['networks.rpc (custom)'] });
    expect(serializeAdapterError(invalid)).toEqual({
      name: 'InvalidInputError',
      message: invalid.message,
      error: invalid.toJSON(),
    });
    const rule = new MandateRuleError(43, 'INSUFFICIENT_FUNDS', { cause: transportError() });
    expect(serializeAdapterError(rule).error).toEqual(rule.toJSON());
    expect(JSON.stringify(serializeAdapterError(rule))).not.toContain(SECRET);
  });

  it('reads the message and cause from the code, not from the instance', () => {
    const err = new RpcTimeoutError({ cause: transportError() });
    const fixedMessage = err.message;
    err.message = `timed out calling ${SECRET_URL}`;
    Object.defineProperty(err, 'cause', { value: transportError(), configurable: true });
    const logged = serializeAdapterError(err);
    expect(logged.message).toBe(fixedMessage);
    expect(logged.cause).toBe('Cause redacted: TypeError');
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it('re-checks the redacted cause text', () => {
    const err = new RpcTimeoutError({ cause: new RangeError('x') });
    expect(serializeAdapterError(err).cause).toBe('Cause redacted: RangeError');
    (err.cause as Error).message = `Cause redacted: ${SECRET}`;
    expect(serializeAdapterError(err).cause).toBe('Cause redacted: Error');
    (err.cause as Error).message = SECRET_URL;
    expect(serializeAdapterError(err).cause).toBe('Cause redacted: Error');
  });

  it('logs anything else by its known class name only', () => {
    const named = Object.assign(new Error('x'), { name: SECRET });
    for (const [value, name] of [
      [transportError(), 'TypeError'],
      [new Error(SECRET_URL), 'Error'],
      [named, 'Error'],
      [SECRET_URL, 'Error'],
      [{ message: SECRET_URL }, 'Error'],
      [null, 'Error'],
      [undefined, 'Error'],
    ] as const) {
      const logged = serializeAdapterError(value);
      expect(logged).toEqual({ name });
      expect(JSON.stringify(logged)).not.toContain(SECRET);
    }
  });

  it('never throws, even for a hostile value', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(SECRET_URL);
        },
      },
    );
    expect(serializeAdapterError(hostile)).toEqual({ name: 'Error' });

    const err = new RpcTimeoutError({});
    Object.defineProperty(err, 'cause', {
      get() {
        throw new Error(SECRET_URL);
      },
    });
    expect(serializeAdapterError(err)).toEqual({ name: 'Error' });
  });

  it('is the serializer under the keys structured loggers use', () => {
    expect(ADAPTER_LOG_SERIALIZERS.err).toBe(serializeAdapterError);
    expect(ADAPTER_LOG_SERIALIZERS.error).toBe(serializeAdapterError);
    expect(Object.isFrozen(ADAPTER_LOG_SERIALIZERS)).toBe(true);
  });
});
