// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a signer service may log, as a closed set of fields. There is no
// field for a payload, a destination, a token, a signature or a key, so
// none of them has anywhere to go: adding one is a visible change to this
// type, not a string someone formats in a handler.

export interface SignerLogFields {
  /** The authenticated caller's name, such as payouts. */
  readonly caller?: string;
  readonly route?: string;
  readonly status?: number;
  readonly refKind?: string;
  readonly network?: string;
  readonly payloadKind?: string;
  /** SHA-256 of the payload as received, in hex: enough to match logs, not to read the payload. */
  readonly payloadHash?: string;
  readonly principalId?: string;
  readonly projectId?: string;
  /** The key manager's request id, when the backend has one. */
  readonly keyRequestId?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
}

export type SignerLogLevel = 'info' | 'warn' | 'error';

export interface SignerLogRecord extends SignerLogFields {
  readonly time: string;
  readonly level: SignerLogLevel;
  readonly event: string;
  readonly requestId: string;
}

export interface SignerLogger {
  write(record: SignerLogRecord): void;
}

export const SIGNER_LOG_FIELDS: readonly (keyof SignerLogFields)[] = Object.freeze([
  'caller',
  'route',
  'status',
  'refKind',
  'network',
  'payloadKind',
  'payloadHash',
  'principalId',
  'projectId',
  'keyRequestId',
  'errorCode',
  'durationMs',
]);

const EVENT = /^[a-z][a-z0-9_]{0,63}$/;

/** One JSON object per line. */
export function jsonSignerLogger(writeLine: (line: string) => void): SignerLogger {
  return {
    write: (record) => {
      writeLine(JSON.stringify(record));
    },
  };
}

/** Keeps records in memory, for tests. */
export function memorySignerLogger(): SignerLogger & { readonly records: SignerLogRecord[] } {
  const records: SignerLogRecord[] = [];
  return {
    records,
    write: (record) => {
      records.push(record);
    },
  };
}

// The type keeps extra keys out at compile time; this keeps them out of an
// object that was widened on the way, which the compiler cannot see.
function knownFields(fields: SignerLogFields): SignerLogFields {
  const copy: Record<string, unknown> = {};
  for (const name of SIGNER_LOG_FIELDS) {
    if (fields[name] !== undefined) copy[name] = fields[name];
  }
  return copy;
}

export function writeLog(
  logger: SignerLogger,
  level: SignerLogLevel,
  event: string,
  requestId: string,
  now: Date,
  fields: SignerLogFields,
): void {
  logger.write({
    ...knownFields(fields),
    time: now.toISOString(),
    level,
    event: EVENT.test(event) ? event : 'invalid_event',
    requestId,
  });
}
