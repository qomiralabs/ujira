// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Dates the way every screen writes them: day, short month, year, so 03/04
// never has to be guessed. They follow the browser's time zone until the
// project's reporting time zone can be chosen.

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const DAY_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 6 Nov 2026 */
export function formatDate(value: Date | string): string {
  return DATE.format(typeof value === 'string' ? new Date(value) : value);
}

/** 6 Nov 2026, 14:05 */
export function formatDateTime(value: Date | string): string {
  return DATE_TIME.format(typeof value === 'string' ? new Date(value) : value);
}

/** 6 Nov, 14:05, for a time days away where the year goes without saying. */
export function formatDayTime(value: Date | string): string {
  return DAY_TIME.format(typeof value === 'string' ? new Date(value) : value);
}

/** The machine readable form for a <time> element. */
export function isoOf(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}
