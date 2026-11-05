// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What decides whether a chain event counts. Anyone can deploy the mandate code
// directly, or write a contract that copies its event shapes, so nothing inside
// an event is believed about where it came from. The source is the contract id
// the ledger recorded. A contract becomes a mandate only when a trusted factory
// says so in mandate_created, and only a mandate's own events are ever booked.
//
// This is the one writer of the registry, whether UJIRA's create flow made the
// mandate or the principal called the factory directly. A mandate UJIRA just
// created counts as registered when its event has been read and not before:
// there is no second way in for a bug or an attacker to reach.

import type { NetworkId } from './networks.js';
import { isPublicTestAttesterKey } from './test-attester-keys.js';
import type { Bytes32, MandateRegistration, TenantScope } from './types.js';

export type EventJson =
  string | boolean | null | readonly EventJson[] | { readonly [field: string]: EventJson };

/** One event as the ledger recorded it. Integers in `fields` are decimal strings. */
export interface LedgerEvent {
  readonly network: NetworkId;
  /** The contract the ledger says emitted it. The only thing believed about its source. */
  readonly contractId: string;
  readonly type: string;
  /** Whether the transaction it came from succeeded. */
  readonly successful: boolean;
  readonly txHash: string;
  /** Its position in the transaction, so a transaction and an index name one event. */
  readonly eventIndex: bigint;
  readonly ledger: bigint;
  /** ISO 8601, as the ledger closed. */
  readonly closedAt: string;
  /** Null when the event is in no shape a mandate or factory emits. */
  readonly name: string | null;
  /** The second topic: a payout ID on a payout event, the tenant tag on any other. */
  readonly key: Bytes32 | null;
  readonly fields: Readonly<Record<string, EventJson>> | null;
}

export interface MandateTenant {
  readonly scope: TenantScope;
  readonly mandateInstanceId: string;
}

export interface NewRegistration {
  readonly network: NetworkId;
  readonly contractId: string;
  readonly factory: string;
  readonly tenantTag: Bytes32;
  readonly txHash: string;
  readonly eventIndex: bigint;
  readonly ledger: bigint;
}

export interface EventBooking {
  readonly tenant: MandateTenant;
  readonly network: NetworkId;
  readonly contractId: string;
  readonly txHash: string;
  readonly eventIndex: bigint;
  readonly ledger: bigint;
  readonly closedAt: string;
  readonly name: string;
  readonly payload: EventJson;
  /** Set when the event moves a payout, null when it only joins the record. */
  readonly payoutId: Bytes32 | null;
}

/** Why a mandate was flagged, which is what operations is told. */
export type MandateFlagReason = 'tenant_tag_mismatch' | 'public_test_attester';

export interface EventIntakeStore {
  registered(network: NetworkId, contractId: string): Promise<MandateRegistration | null>;
  /** Unique on network and contract. True when this call added it. */
  register(registration: NewRegistration): Promise<boolean>;
  /**
   * A flag is never lifted. It raises an alert for its reason in the same transaction,
   * once per reason however often the event is read again.
   */
  flag(network: NetworkId, contractId: string, reason: MandateFlagReason): Promise<void>;
  /** The tenant that claims this contract, or null when none has. */
  tenantOf(network: NetworkId, contractId: string): Promise<MandateTenant | null>;
  /**
   * Stores the event and moves its payout in one transaction. Unique on chain,
   * transaction and event index, and a payout on chain, contract and payout ID.
   * True when the event was new; a replay changes nothing.
   */
  book(booking: EventBooking): Promise<boolean>;
}

export type IgnoredReason =
  /** A diagnostic or system event, which any contract can produce and nothing relies on. */
  | 'not_a_contract_event'
  | 'failed_transaction'
  | 'wrong_network'
  /** A trusted factory or registered mandate, in a shape it does not emit. */
  | 'malformed'
  /** A trusted factory's event that is not a creation. */
  | 'not_a_creation'
  /** mandate_created from anything but a trusted factory, a registered mandate included. */
  | 'creation_off_list'
  | 'unregistered'
  | 'flagged'
  | 'factory_off_list'
  /** Registered, but no tenant claims it, so there is no one to book it to. */
  | 'unattributed';

export type IntakeOutcome =
  | { readonly action: 'ignored'; readonly reason: IgnoredReason }
  | { readonly action: 'registered'; readonly contractId: string; readonly created: boolean }
  | { readonly action: 'flagged'; readonly contractId: string }
  | { readonly action: 'booked'; readonly created: boolean };

export interface EventIntakeOptions {
  readonly network: NetworkId;
  readonly store: EventIntakeStore;
  /** Read for every event, so a reviewed change to the list takes effect at once. */
  readonly trustedFactories: () => readonly string[];
  /** The tag a mandate at this address carries for this tenant. */
  readonly tenantTagFor: (scope: TenantScope, contractId: string) => Bytes32;
  /**
   * The process environment. Only the exact value `test` lets the public test attester
   * keys through, so a deployment that never set it still flags them.
   */
  readonly nodeEnv?: string;
}

export interface EventIntake {
  /** Decides one event. Replaying a range of events changes nothing. */
  ingest(event: LedgerEvent): Promise<IntakeOutcome>;
}

/** The events that move a payout. A refused batch item is on record, but no payout exists. */
const PAYOUT_MOVES: ReadonlySet<string> = new Set([
  'payout_requested',
  'payout_approval_added',
  'payout_approved',
  'payout_rejected',
  'payout_cancelled',
  'payout_executed',
]);

const PAYOUT_KEYED: ReadonlySet<string> = new Set([...PAYOUT_MOVES, 'payout_request_rejected']);

/** The events that set a mandate's attester. mandate_created does not carry it. */
const ATTESTER_EVENTS: ReadonlySet<string> = new Set([
  'mandate_initialized',
  'attestation_policy_set',
]);

const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;

// Anyone can rebuild the private keys of these two, so a mandate on one pays out on
// anybody's attestation, and the contract only checks a key's length. Refusing them when
// UJIRA prepares an action misses a principal who calls the factory or
// set_attestation_policy directly, and a mandate already deployed. Every one of those
// passes through here.
function setsTestAttester(name: string, fields: Readonly<Record<string, EventJson>>): boolean {
  if (!ATTESTER_EVENTS.has(name)) return false;
  const attester = fields['attester'];
  return (
    typeof attester === 'string' &&
    HEX_BYTES.test(attester) &&
    isPublicTestAttesterKey(Buffer.from(attester.slice(2), 'hex'))
  );
}

function ignored(reason: IgnoredReason): IntakeOutcome {
  return { action: 'ignored', reason };
}

export function createEventIntake(options: EventIntakeOptions): EventIntake {
  const { network, store, trustedFactories, tenantTagFor, nodeEnv } = options;

  // A tag is proof only once it is recomputed here for the tenant that claims
  // the contract. A difference flags the mandate, and nothing of it is booked.
  async function tenantOf(
    contractId: string,
    tag: Bytes32,
  ): Promise<MandateTenant | 'unattributed' | 'flagged'> {
    const tenant = await store.tenantOf(network, contractId);
    if (tenant === null) return 'unattributed';
    if (tenantTagFor(tenant.scope, contractId) === tag) return tenant;
    await store.flag(network, contractId, 'tenant_tag_mismatch');
    return 'flagged';
  }

  async function fromFactory(event: LedgerEvent): Promise<IntakeOutcome> {
    if (event.name !== 'mandate_created') return ignored('not_a_creation');
    const mandate = event.fields?.['mandate'];
    if (typeof mandate !== 'string' || event.key === null) return ignored('malformed');
    const created = await store.register({
      network,
      contractId: mandate,
      factory: event.contractId,
      tenantTag: event.key,
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      ledger: event.ledger,
    });
    if ((await tenantOf(mandate, event.key)) === 'flagged') {
      return { action: 'flagged', contractId: mandate };
    }
    return { action: 'registered', contractId: mandate, created };
  }

  async function fromMandate(event: LedgerEvent, name: string): Promise<IntakeOutcome> {
    const { contractId, key, fields } = event;
    const registration = await store.registered(network, contractId);
    if (registration === null) return ignored('unregistered');
    if (registration.flagged) return ignored('flagged');
    if (!trustedFactories().includes(registration.factory)) return ignored('factory_off_list');
    if (key === null || fields === null) return ignored('malformed');
    // Ahead of the tenant lookup: a mandate made directly through the factory may have no
    // instance row, and would be dropped below as unattributed with its key never seen.
    if (nodeEnv !== 'test' && setsTestAttester(name, fields)) {
      await store.flag(network, contractId, 'public_test_attester');
      return { action: 'flagged', contractId };
    }
    const tenant = await tenantOf(contractId, registration.tenantTag);
    if (tenant === 'unattributed') return ignored('unattributed');
    if (tenant === 'flagged') return { action: 'flagged', contractId };
    const keyField = PAYOUT_KEYED.has(name) ? 'payout_id' : 'tenant_tag';
    const created = await store.book({
      tenant,
      network,
      contractId,
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      ledger: event.ledger,
      closedAt: event.closedAt,
      name,
      payload: { ...fields, [keyField]: key },
      payoutId: PAYOUT_MOVES.has(name) ? key : null,
    });
    return { action: 'booked', created };
  }

  return {
    async ingest(event) {
      if (event.network !== network) return ignored('wrong_network');
      if (event.type !== 'contract') return ignored('not_a_contract_event');
      if (!event.successful) return ignored('failed_transaction');
      if (trustedFactories().includes(event.contractId)) return fromFactory(event);
      if (event.name === 'mandate_created') return ignored('creation_off_list');
      if (event.name === null) {
        return (await store.registered(network, event.contractId)) === null
          ? ignored('unregistered')
          : ignored('malformed');
      }
      return fromMandate(event, event.name);
    },
  };
}
