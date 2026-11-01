// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Structured logs with a closed set of fields. There is no field for a
// message, a body, a header or an error's text, so a request's personal data
// has nowhere to go: adding one is a visible change to this type, not a
// string someone formats in a handler.

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  /** The route template, such as /v1/payouts/{id}, never the path as sent. */
  readonly route?: string;
  readonly method?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly principalId?: string;
  readonly projectId?: string;
  readonly errorCode?: string;
  /** A class name only. */
  readonly errorName?: string;
  /** Paths into a document, such as items.0.amount; never the values there. */
  readonly issues?: readonly string[];
  /** The id of the resource a handler acted on. */
  readonly resourceId?: string;
  readonly count?: number;
  /** The port a server bound. */
  readonly port?: number;
}

export interface LogRecord extends LogFields {
  readonly time: string;
  readonly level: LogLevel;
  /** snake_case, from a fixed set in code. */
  readonly event: string;
  readonly requestId?: string;
}

export interface Logger {
  write(record: LogRecord): void;
}

/** What a handler gets: the request id is attached for it. */
export interface RequestLog {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const EVENT = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** One JSON object per line. */
export function jsonLogger(writeLine: (line: string) => void): Logger {
  return {
    write: (record) => {
      writeLine(JSON.stringify(record));
    },
  };
}

export const stdoutLogger: Logger = jsonLogger((line) => {
  process.stdout.write(`${line}\n`);
});

/** Keeps records in memory, for tests. */
export function memoryLogger(): Logger & { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    write: (record) => {
      records.push(record);
    },
  };
}

/** The class name of a thrown value, or Error when it has none worth printing. */
export function errorNameOf(error: unknown): string {
  try {
    if (!(error instanceof Error)) return 'NonError';
    const name: unknown = error.name;
    return typeof name === 'string' && ERROR_NAME.test(name) ? name : 'Error';
  } catch {
    // A Proxy can throw from getPrototypeOf or from the name getter.
    return 'Error';
  }
}

const FIELD_NAMES: readonly (keyof LogFields)[] = [
  'route',
  'method',
  'status',
  'durationMs',
  'principalId',
  'projectId',
  'errorCode',
  'errorName',
  'issues',
  'resourceId',
  'count',
  'port',
];

// The type keeps extra keys out at compile time; this keeps them out of an
// object that was widened on the way, which the compiler cannot see.
function knownFields(fields: LogFields): LogFields {
  const copy: Record<string, unknown> = {};
  for (const name of FIELD_NAMES) {
    if (fields[name] !== undefined) copy[name] = fields[name];
  }
  return copy;
}

export function requestLog(logger: Logger, requestId: string, now: () => Date): RequestLog {
  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    logger.write({
      ...knownFields(fields),
      time: now().toISOString(),
      level,
      // A malformed event name is a bug at the call site; it still logs,
      // under a name that cannot carry text from the request.
      event: EVENT.test(event) ? event : 'invalid_event',
      requestId,
    });
  };
  return {
    info: (event, fields) => {
      write('info', event, fields);
    },
    warn: (event, fields) => {
      write('warn', event, fields);
    },
    error: (event, fields) => {
      write('error', event, fields);
    },
  };
}
