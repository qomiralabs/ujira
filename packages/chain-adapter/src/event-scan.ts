// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One step of the chain event indexer: read a page from where the last step
// stopped, decide each event, and only then move the cursor. A crash anywhere in
// between reads the same page again, which changes nothing, because intake's writes
// are all keyed. Nothing here knows a chain, and nothing here decides whether an
// event counts: that is intake's, and it is the only writer of the registry.

import type { EventIntake, IgnoredReason, LedgerEvent } from './intake.js';
import type { NetworkId } from './networks.js';
import type { CallOptions } from './types.js';

export interface EventPage {
  readonly events: readonly LedgerEvent[];
  readonly nextCursor: string;
  readonly latestLedger: number;
}

/** Where events come from, with the source of each as the ledger recorded it. */
export interface EventSource {
  page(cursor: string | null, limit: number, opts: CallOptions): Promise<EventPage>;
}

export interface CursorStore {
  read(stream: string): Promise<string | null>;
  /** Written after the page it follows, so a crash reads that page again. */
  advance(stream: string, cursor: string): Promise<void>;
}

export interface ScanResult {
  readonly events: number;
  readonly registered: number;
  readonly flagged: number;
  readonly booked: number;
  /** Events already stored, read again after a restart. */
  readonly replayed: number;
  readonly ignored: Readonly<Partial<Record<IgnoredReason, number>>>;
  readonly cursor: string;
  readonly latestLedger: number;
}

export interface EventScanOptions {
  readonly network: NetworkId;
  readonly source: EventSource;
  readonly intake: EventIntake;
  readonly cursors: CursorStore;
  /** Events a page reads. At most what the node allows. */
  readonly pageSize: number;
}

/** A network's mandate events have one cursor. */
export function eventStream(network: NetworkId): string {
  return network;
}

export function createEventScan(options: EventScanOptions) {
  const { network, source, intake, cursors, pageSize } = options;
  const stream = eventStream(network);
  return {
    /** One page. The job runs this on its schedule, one at a time per network. */
    async step(opts: CallOptions): Promise<ScanResult> {
      const page = await source.page(await cursors.read(stream), pageSize, opts);
      let registered = 0;
      let flagged = 0;
      let booked = 0;
      let replayed = 0;
      const ignored: Partial<Record<IgnoredReason, number>> = {};
      // In ledger order and one at a time: a mandate's creation has to be read
      // before its first event, and both can be on one page.
      for (const event of page.events) {
        const outcome = await intake.ingest(event);
        switch (outcome.action) {
          case 'registered':
            registered += 1;
            break;
          case 'flagged':
            flagged += 1;
            break;
          case 'booked':
            if (outcome.created) booked += 1;
            else replayed += 1;
            break;
          case 'ignored':
            ignored[outcome.reason] = (ignored[outcome.reason] ?? 0) + 1;
            break;
        }
      }
      await cursors.advance(stream, page.nextCursor);
      return {
        events: page.events.length,
        registered,
        flagged,
        booked,
        replayed,
        ignored,
        cursor: page.nextCursor,
        latestLedger: page.latestLedger,
      };
    },
  };
}
