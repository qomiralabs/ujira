// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a handler's work can say went wrong. Anything else that it throws is a bug
// or a crash, and goes to the library's own retries.
//
// Each carries a code rather than a message worth keeping, because a code is all
// that reaches a dead letter, an alert or a log.

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function checkedCode(code: string): string {
  if (!CODE.test(code)) throw new RangeError('an error code is upper case words and underscores');
  return code;
}

// Worth another try: a timeout, an outage, a chain that has not caught up.
export class RetryableJobError extends Error {
  override readonly name = 'RetryableJobError';
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(checkedCode(code), options);
    this.code = code;
  }
}

// Will be the same on every try, so it ends the job with no retry.
export class TerminalRefusal extends Error {
  override readonly name = 'TerminalRefusal';
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(checkedCode(code), options);
    this.code = code;
  }
}

export const AMOUNT_BELOW_MINIMUM = 'AMOUNT_BELOW_MINIMUM';

// The payload is not repeated: it is the queue's, and this message reaches a log.
export class JobPayloadError extends Error {
  override readonly name = 'JobPayloadError';

  constructor(task: string) {
    super(`the payload of a ${task} job is not valid`);
  }
}

// A task name the library's crontab parser and the queue would both refuse.
export class WorkerConfigError extends Error {
  override readonly name = 'WorkerConfigError';
}
