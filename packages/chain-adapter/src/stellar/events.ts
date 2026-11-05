// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reads events off the ledger for intake. Anyone can emit anything, so an event
// that does not decode is a fact about that contract and never stops a scan; a
// page that does not parse is a fact about the endpoint, and it does.

import { scValToNative, xdr } from '@stellar/stellar-sdk/base';

import { ChainUnavailableError, InvalidInputError } from '../errors.js';
import type { EventSource } from '../event-scan.js';
import { createEventIntake } from '../intake.js';
import type { EventIntake, EventIntakeStore, EventJson, LedgerEvent } from '../intake.js';
import type { NetworkId } from '../networks.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import type { Bytes32, CallOptions, TenantScope } from '../types.js';
import { addressXdr } from './address-xdr.js';
import type { RpcEvent, RpcEventRequest, StellarRpc } from './rpc.js';

// The id is the operation's position and then the event's within it, and a
// Soroban transaction has one operation, so the last part is its place in the
// transaction.
const EVENT_ID = /^(\d+)-(\d+)$/;

/** The operation an event came from and its place there, as the ledger numbers them. */
export function eventPositionOf(
  network: NetworkId,
  raw: Pick<RpcEvent, 'id'>,
): { readonly operationId: string; readonly eventIndex: bigint } {
  const found = EVENT_ID.exec(raw.id);
  const [, operation, index] = found ?? [];
  if (operation === undefined || index === undefined) throw new ChainUnavailableError({ network });
  return { operationId: BigInt(operation).toString(), eventIndex: BigInt(index) };
}

function jsonOf(value: unknown): EventJson {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  // Integers as text, whatever their size, so none of them ever passes through a float.
  if (typeof value === 'bigint' || typeof value === 'number') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(jsonOf);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonOf(v)]));
  }
  throw new TypeError('not an event value');
}

function decoded(raw: RpcEvent): Pick<LedgerEvent, 'name' | 'key' | 'fields'> {
  const unknown = { name: null, key: null, fields: null };
  try {
    const [nameTopic, keyTopic] = raw.topic.map((t) => xdr.ScVal.fromXdr(t, 'base64'));
    if (raw.topic.length !== 2 || nameTopic?.type !== 'scvSymbol') return unknown;
    if (keyTopic?.type !== 'scvBytes' || keyTopic.bytes.value.length !== 32) return unknown;
    const fields = jsonOf(scValToNative(xdr.ScVal.fromXdr(raw.value, 'base64')));
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return unknown;
    return {
      name: nameTopic.sym.toString(),
      key: `0x${Buffer.from(keyTopic.bytes.value).toString('hex')}` as Bytes32,
      fields: fields as Readonly<Record<string, EventJson>>,
    };
  } catch {
    return unknown;
  }
}

/** One RPC event as intake reads it, with its source as the ledger recorded it. */
export function ledgerEventOf(network: NetworkId, raw: RpcEvent): LedgerEvent {
  const { eventIndex } = eventPositionOf(network, raw);
  return {
    network,
    contractId: raw.contractId,
    type: raw.type,
    successful: raw.inSuccessfulContractCall,
    txHash: raw.txHash,
    eventIndex,
    ledger: BigInt(raw.ledger),
    closedAt: raw.ledgerClosedAt,
    ...decoded(raw),
  };
}

export interface LedgerEventPage {
  readonly events: readonly LedgerEvent[];
  /** Where to read from next. */
  readonly cursor: string | null;
  readonly latestLedger: number;
}

/** One page of contract events, every contract's: which of them count is intake's call. */
export async function scanLedgerEvents(
  network: NetworkId,
  rpc: Pick<StellarRpc, 'getEvents'>,
  request: RpcEventRequest,
  opts: CallOptions,
): Promise<LedgerEventPage> {
  const page = await rpc.getEvents(request, opts);
  return {
    events: page.events.map((raw) => ledgerEventOf(network, raw)),
    cursor: page.cursor,
    latestLedger: page.latestLedger,
  };
}

const CURSOR_PREFIX = 'stellar:v1:';

/**
 * Where the scan reads Stellar contract events from. The cursor is the node's own,
 * kept as text. With none from the node the next one stays where the page started:
 * reading a range again only repeats events, which every write drops, and moving on
 * could skip one.
 */
export function createStellarEventSource(options: {
  readonly network: NetworkId;
  readonly rpc: Pick<StellarRpc, 'getEvents'>;
  /** Where a network with no cursor yet starts. */
  readonly startLedger: number;
}): EventSource {
  const { network, rpc, startLedger } = options;
  return {
    async page(cursor, limit, opts) {
      const position = positionOf(network, cursor, startLedger);
      const page = await scanLedgerEvents(network, rpc, { ...position, limit }, opts);
      const here =
        'cursor' in position
          ? `${CURSOR_PREFIX}cursor:${position.cursor}`
          : `${CURSOR_PREFIX}ledger:${String(position.startLedger)}`;
      return {
        events: page.events,
        nextCursor: page.cursor === null ? here : `${CURSOR_PREFIX}cursor:${page.cursor}`,
        latestLedger: page.latestLedger,
      };
    },
  };
}

function positionOf(
  network: NetworkId,
  cursor: string | null,
  startLedger: number,
): { startLedger: number } | { cursor: string } {
  if (cursor === null) return { startLedger };
  const rest = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : '';
  if (rest.startsWith('cursor:') && rest.length > 'cursor:'.length) {
    return { cursor: rest.slice('cursor:'.length) };
  }
  const ledger = rest.startsWith('ledger:') ? rest.slice('ledger:'.length) : '';
  if (!/^\d{1,15}$/.test(ledger)) {
    throw new InvalidInputError({ network, issues: ['cursor (invalid)'] });
  }
  return { startLedger: Number(ledger) };
}

/** The tag a mandate at this address carries for this tenant, as the factory stored it. */
export function stellarTenantTag(scope: TenantScope, contractId: string): Bytes32 {
  return tenantTagOf(tenantRefOf(scope), addressXdr(contractId));
}

export function createStellarEventIntake(options: {
  readonly network: NetworkId;
  readonly store: EventIntakeStore;
  readonly trustedFactories: () => readonly string[];
  readonly nodeEnv?: string;
}): EventIntake {
  return createEventIntake({ ...options, tenantTagFor: stellarTenantTag });
}
