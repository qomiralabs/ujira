// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorNameOf, jsonLogger, memoryLogger, requestLog, stdoutLogger } from './log.js';
import type { LogFields } from './log.js';

const NOW = () => new Date('2026-10-31T12:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logs', () => {
  it('writes one JSON object per line with the request id attached', () => {
    const lines: string[] = [];
    const log = requestLog(
      jsonLogger((line) => lines.push(line)),
      'req_0123456789',
      NOW,
    );
    log.warn('slow_call', { durationMs: 1200 });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        durationMs: 1200,
        time: '2026-10-31T12:00:00.000Z',
        level: 'warn',
        event: 'slow_call',
        requestId: 'req_0123456789',
      },
    ]);
  });

  it('drops any field outside the closed set, even from a widened object', () => {
    const logger = memoryLogger();
    const widened = { count: 2, email: 'ada@example.com', body: { name: 'Ada' } } as LogFields;
    requestLog(logger, 'req_0123456789', NOW).error('thing_failed', widened);
    expect(logger.records[0]).toEqual({
      count: 2,
      time: '2026-10-31T12:00:00.000Z',
      level: 'error',
      event: 'thing_failed',
      requestId: 'req_0123456789',
    });
  });

  it('replaces an event name that could carry text', () => {
    const logger = memoryLogger();
    requestLog(logger, 'req_0123456789', NOW).info('paid ada@example.com');
    expect(logger.records[0]?.event).toBe('invalid_event');
  });

  it('writes to stdout by default', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stdoutLogger.write({ time: 't', level: 'info', event: 'listening', port: 8080 });
    expect(write).toHaveBeenCalledWith(
      '{"time":"t","level":"info","event":"listening","port":8080}\n',
    );
  });
});

describe('errorNameOf', () => {
  it('keeps a class name and nothing else', () => {
    expect(errorNameOf(new TypeError('x'))).toBe('TypeError');
    expect(errorNameOf('a string')).toBe('NonError');
    const named = new Error('x');
    named.name = 'ada@example.com';
    expect(errorNameOf(named)).toBe('Error');
    const hostile = new Proxy(new Error('x'), {
      get: () => {
        throw new Error('trap');
      },
    });
    expect(errorNameOf(hostile)).toBe('Error');
  });
});
