// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Tells operations of every flagged mandate. Intake records why a mandate was flagged in
// the same transaction as the flag, and from then on reads none of its events, so its
// mirror goes quiet while the principal's funds are still there to withdraw on chain.
// A row nobody reads protects nobody, so this reads them, in order, from where the last
// delivery stopped, and moves the position after each one it has told.
//
// Only operations is told. A mandate made directly through the factory may have no
// tenant, and the reasons are about a contract UJIRA will not trust, which operations
// takes up with the principal when there is one.

import type { MandateFlagReason } from '@ujira/chain-adapter';
import { alertDeliveryCursors, mandateRegistry, type Database } from '@ujira/db';

export interface MandateFlagAlert {
  /** Increases with every alert raised, so it orders them and names each one. */
  readonly alertId: bigint;
  readonly network: string;
  /** Public on the chain; never a tenant or a person. */
  readonly contractId: string;
  readonly reason: MandateFlagReason;
  readonly raisedAt: Date;
}

export interface MandateAlertSink {
  /**
   * Tells operations of one alert. `idempotencyKey` is the same every time this alert
   * is sent, so a sink that can drop a repeat should key on it.
   */
  mandateFlagged(
    alert: MandateFlagAlert,
    opts: { readonly signal: AbortSignal; readonly idempotencyKey: string },
  ): Promise<void>;
}

/** The sink failed or did not answer in time. Every alert before this one was told. */
export class AlertDeliveryError extends Error {
  override readonly name = 'AlertDeliveryError';
  readonly alertId: bigint;

  constructor(alertId: bigint, options: { readonly cause: unknown }) {
    super(`mandate alert ${String(alertId)} was not delivered`, options);
    this.alertId = alertId;
  }
}

export interface MandateAlertDeliveryOptions {
  readonly db: Pick<Database, 'unscoped'>;
  readonly sink: MandateAlertSink;
  /** Whose position this is. Each sink keeps its own, so a new one starts from the first alert. */
  readonly sinkName?: string;
  readonly batchSize?: number;
  /** Bound on each call to the sink. */
  readonly timeoutMs?: number;
}

export const OPERATIONS_SINK = 'operations';
const DEFAULT_BATCH = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

function withTimeout(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer in ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function createMandateAlertDelivery(options: MandateAlertDeliveryOptions) {
  const { db, sink } = options;
  const sinkName = options.sinkName ?? OPERATIONS_SINK;
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    /**
     * Tells the sink every alert raised since the last delivery, oldest first, and
     * returns how many. Stops at the first the sink does not take, with every earlier
     * one told and recorded, and throws AlertDeliveryError.
     *
     * The position moves after the sink answers, so an alert is never lost. A process
     * that dies between the two tells that one alert again on restart, under the same
     * idempotency key.
     */
    async deliverPending(): Promise<number> {
      let after = await db.unscoped((tx) => alertDeliveryCursors.read(tx, sinkName), 'indexer');
      let delivered = 0;
      for (;;) {
        const rows = await db.unscoped(
          (tx) => mandateRegistry.alertsAfter(tx, after, batchSize),
          'indexer',
        );
        for (const row of rows) {
          const alert: MandateFlagAlert = {
            alertId: row.id,
            network: row.network,
            contractId: row.contractId,
            reason: row.reason,
            raisedAt: row.raisedAt,
          };
          try {
            await withTimeout(timeoutMs, (signal) =>
              sink.mandateFlagged(alert, {
                signal,
                idempotencyKey: `mandate-alert:${String(row.id)}`,
              }),
            );
          } catch (error) {
            throw new AlertDeliveryError(row.id, { cause: error });
          }
          await db.unscoped((tx) => alertDeliveryCursors.advance(tx, sinkName, row.id), 'indexer');
          after = row.id;
          delivered += 1;
        }
        if (rows.length < batchSize) return delivered;
      }
    },
  };
}

/**
 * Operations reads the error log, so until a pager is wired this is how an alert reaches
 * it: one line per alert, naming only the alert, the contract and the reason.
 */
export function logMandateAlertSink(
  write: (line: Readonly<Record<string, unknown>>) => void,
): MandateAlertSink {
  return {
    mandateFlagged(alert) {
      write({
        time: new Date().toISOString(),
        level: 'error',
        event: 'mandate_flagged',
        alertId: String(alert.alertId),
        network: alert.network,
        contractId: alert.contractId,
        reason: alert.reason,
        raisedAt: alert.raisedAt.toISOString(),
      });
      return Promise.resolve();
    },
  };
}
