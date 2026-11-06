// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the recipient endpoints do. Personal data is encrypted here, before anything
// stores it and outside any database transaction, under a key bound to the tenant
// and the recipient. Every destination goes through the same capture onboarding
// uses, so a recipient endpoint can never accept what the widget refuses.

import { createHmac, randomUUID } from 'node:crypto';

import { RecipientPersonalData } from '@ujira/api-schema';
import type { RecipientPayoutMethod, RecipientSummaryView } from '@ujira/api-schema';
import { chainOf } from '@ujira/chain-adapter';
import { MAX_PAGE_SIZE } from '@ujira/db';
import type { z } from 'zod';

import type { Tenant } from './auth.js';
import { readRecipientDestination } from './destination.js';
import type { RecipientDestinationBody } from './destination.js';
import { ApiError } from './errors.js';
import type { RecipientEndpoints } from './routes/recipients.js';

export interface EncryptedValue {
  readonly ciphertext: Buffer;
  /** 12 bytes. */
  readonly nonce: Buffer;
}

/** Encrypts under one data key per recipient, wrapped by the key manager. */
export interface PersonalDataCipher {
  readonly encrypt: (
    tenant: Tenant,
    recipientId: string,
    plaintext: Uint8Array,
    signal: AbortSignal,
  ) => Promise<EncryptedValue>;
  readonly decrypt: (
    tenant: Tenant,
    recipientId: string,
    value: EncryptedValue,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
}

export interface StoredRecipient {
  readonly id: string;
  readonly country: string;
  readonly status: string;
  readonly createdAt: Date;
}

export interface StoredMethod {
  readonly id: string;
  readonly recipientId: string;
  readonly method: string;
  readonly rail: string;
  readonly chain: string;
  readonly destinationAddress: string;
  readonly destinationTag: bigint | null;
  readonly hasDetails: boolean;
  readonly status: string;
}

/** The recipient rows. Every method takes the tenant, and sees nothing outside it. */
export interface RecipientRecords {
  /** The recipient this reference names: this one, or the one already there. */
  readonly createOnce: (
    tenant: Tenant,
    recipient: {
      readonly id: string;
      readonly recipientRef: Buffer;
      readonly country: string;
      readonly personal: EncryptedValue | null;
    },
  ) => Promise<StoredRecipient>;
  readonly find: (tenant: Tenant, id: string) => Promise<StoredRecipient | undefined>;
  readonly list: (
    tenant: Tenant,
    page: { readonly limit: number; readonly after?: string },
  ) => Promise<{ readonly items: readonly StoredRecipient[]; readonly next: string | null }>;
  readonly personal: (tenant: Tenant, id: string) => Promise<EncryptedValue | undefined>;
  readonly methods: (tenant: Tenant, id: string) => Promise<readonly StoredMethod[]>;
  readonly addMethod: (
    tenant: Tenant,
    method: {
      readonly recipientId: string;
      readonly method: 'stellar_wallet' | 'bank' | 'mobile_money' | 'cash_pickup';
      readonly rail: 'wallet' | 'anchor';
      readonly chain: string;
      readonly destinationAddress: string;
      readonly destinationTag: bigint | null;
      readonly details: EncryptedValue | null;
    },
  ) => Promise<StoredMethod>;
}

export interface RecipientServiceDeps {
  readonly records: RecipientRecords;
  readonly cipher: PersonalDataCipher;
  /** The secret a reference is hashed with, so a guessable one cannot be tested against a row. */
  readonly refSalt: Uint8Array;
  /**
   * What a network settles through, from settlementAddressesOf, where a payout
   * would be burned. Required, so a wiring cannot leave the rule out.
   */
  readonly neverPayable: (network: RecipientDestinationBody['network']) => readonly string[];
}

const DEFAULT_PAGE = 50;

function recipientRefOf(salt: Uint8Array, tenant: Tenant, text: string): Buffer {
  return createHmac('sha256', salt)
    .update(JSON.stringify([tenant.principalId, tenant.projectId, text]))
    .digest();
}

function summaryOf(tenant: Tenant, stored: StoredRecipient): z.input<typeof RecipientSummaryView> {
  return {
    principalId: tenant.principalId,
    projectId: tenant.projectId,
    id: stored.id,
    country: stored.country,
    status: stored.status as z.input<typeof RecipientSummaryView>['status'],
    createdAt: stored.createdAt.toISOString(),
  };
}

function methodOf(stored: StoredMethod): z.input<typeof RecipientPayoutMethod> {
  return {
    id: stored.id,
    recipientId: stored.recipientId,
    method: stored.method as z.input<typeof RecipientPayoutMethod>['method'],
    rail: stored.rail as z.input<typeof RecipientPayoutMethod>['rail'],
    chain: stored.chain,
    destination: stored.destinationAddress,
    tag: stored.destinationTag === null ? null : stored.destinationTag.toString(),
    hasDetails: stored.hasDetails,
    status: stored.status as z.input<typeof RecipientPayoutMethod>['status'],
  };
}

function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * What a recipient is called where a payout is shown: the full name they were
 * registered with, decrypted for this read only, or a label from their id when
 * no name was given or it has been erased.
 */
export function recipientNames(
  records: Pick<RecipientRecords, 'personal'>,
  cipher: Pick<PersonalDataCipher, 'decrypt'>,
): (
  tenant: Tenant,
  recipientIds: readonly string[],
  signal: AbortSignal,
) => Promise<ReadonlyMap<string, string>> {
  return async (tenant, recipientIds, signal) => {
    const names = new Map<string, string>();
    for (const id of recipientIds) {
      const held = await records.personal(tenant, id);
      if (held === undefined) {
        names.set(id, `Recipient ${id.slice(0, 8)}`);
        continue;
      }
      const personal = RecipientPersonalData.parse(
        JSON.parse(new TextDecoder().decode(await cipher.decrypt(tenant, id, held, signal))),
      );
      names.set(id, personal.fullName);
    }
    return names;
  };
}

export function createRecipientEndpoints(deps: RecipientServiceDeps): RecipientEndpoints {
  const { records, cipher } = deps;

  const found = async (id: string, tenant: Tenant): Promise<StoredRecipient> => {
    const stored = await records.find(tenant, id);
    // Another tenant's id reads exactly like one that never existed.
    if (stored === undefined) throw new ApiError('NOT_FOUND');
    return stored;
  };

  return {
    create: async (body, context) => {
      const { tenant } = context;
      // The pipeline requires one on every tenant write, so this is a bug if it fires.
      if (context.idempotencyKey === null) throw new ApiError('INTERNAL');
      const id = randomUUID();
      // A second run of one request hashes to the same reference, so the unique
      // constraint on it finds the first run's recipient rather than making another.
      const recipientRef = recipientRefOf(
        deps.refSalt,
        tenant,
        body.reference === undefined
          ? `idempotency-key:${context.idempotencyKey}`
          : `reference:${body.reference}`,
      );
      const personal =
        body.personal === undefined
          ? null
          : await cipher.encrypt(tenant, id, encoded(body.personal), context.signal);
      const stored = await records.createOnce(tenant, {
        id,
        recipientRef,
        country: body.country,
        personal,
      });
      return summaryOf(tenant, stored);
    },

    get: async (id, context) => {
      const { tenant } = context;
      const stored = await found(id, tenant);
      const held = await records.personal(tenant, id);
      const personal =
        held === undefined
          ? null
          : RecipientPersonalData.parse(
              JSON.parse(
                new TextDecoder().decode(await cipher.decrypt(tenant, id, held, context.signal)),
              ),
            );
      const methods = await records.methods(tenant, id);
      return { ...summaryOf(tenant, stored), personal, methods: methods.map(methodOf) };
    },

    list: async (query, context) => {
      const { tenant } = context;
      const page = await records.list(tenant, {
        // The wire allows what any list allows; a page here stops at what the table serves.
        limit: Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE_SIZE),
        ...(query.after === undefined ? {} : { after: query.after }),
      });
      return {
        items: page.items.map((item) => summaryOf(tenant, item)),
        nextAfter: page.next,
      };
    },

    addMethod: async (id, body, context) => {
      const { tenant } = context;
      await found(id, tenant);
      const captured = readRecipientDestination(
        body.destination,
        deps.neverPayable(body.destination.network),
      );
      const details =
        body.details === undefined
          ? null
          : await cipher.encrypt(tenant, id, encoded(body.details), context.signal);
      const stored = await records.addMethod(tenant, {
        recipientId: id,
        method: body.method,
        rail: body.method === 'stellar_wallet' ? 'wallet' : 'anchor',
        chain: chainOf(captured.network),
        destinationAddress: captured.address,
        destinationTag: captured.tag === null ? null : BigInt(captured.tag),
        details,
      });
      return methodOf(stored);
    },
  };
}
