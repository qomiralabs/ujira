// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Recipients and how they are paid. Personal data travels only where a schema
// marks it, and only ever on a read: a write's answer is stored for replay, so the
// API refuses to serve a write route whose response holds any.

import { z } from 'zod';

import {
  ChainAddress,
  CountryCode,
  Timestamp,
  Uuid,
  personalData,
  tenantFields,
} from './common.js';
import { pageQueryFields } from './envelope.js';
import { PayoutMethod } from './enums.js';

export const RecipientStatus = z.enum(['active', 'suspended', 'erased']);

/** What is known about the person. Encrypted before it is stored; this shape never is. */
export const RecipientPersonalData = z.strictObject({
  fullName: personalData(z.string().min(1).max(200)),
  email: personalData(z.email().max(254)).optional(),
  phone: personalData(z.string().min(3).max(32)).optional(),
});
export type RecipientPersonalData = z.infer<typeof RecipientPersonalData>;

export const CreateRecipientRequest = z.strictObject({
  country: CountryCode,
  /**
   * Your own reference for this person, which recognizes them again: the same
   * reference gives the same recipient. Only its keyed hash is kept.
   */
  reference: z.string().min(1).max(200).optional(),
  personal: RecipientPersonalData.optional(),
});

const recipientFields = {
  ...tenantFields,
  id: Uuid,
  country: CountryCode,
  status: RecipientStatus,
  createdAt: Timestamp,
} as const;

/** A recipient with nothing personal in it, which is all a list or a write may show. */
export const RecipientSummaryView = z.strictObject(recipientFields);
export type RecipientSummaryView = z.infer<typeof RecipientSummaryView>;

export const RecipientPayoutMethod = z.strictObject({
  id: Uuid,
  recipientId: Uuid,
  method: PayoutMethod,
  rail: z.enum(['wallet', 'anchor']),
  chain: z.string().min(1).max(32),
  /** The one text to show for it, with any numeric memo carried inside. */
  destination: ChainAddress,
  /** The numeric tag in decimal, or null. Text, so it survives JSON at full width. */
  tag: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .nullable(),
  /** Whether encrypted details are held. They are never sent back. */
  hasDetails: z.boolean(),
  status: z.enum(['active', 'disabled']),
});
export type RecipientPayoutMethod = z.infer<typeof RecipientPayoutMethod>;

export const RecipientDetail = z.strictObject({
  ...recipientFields,
  /** Null when none is held, or once the recipient has been erased. */
  personal: RecipientPersonalData.nullable(),
  methods: z.array(RecipientPayoutMethod).max(50),
});
export type RecipientDetail = z.infer<typeof RecipientDetail>;

export const RecipientListQuery = z.strictObject({
  limit: pageQueryFields.limit,
  /** The id the last page ended on. */
  after: Uuid.optional(),
});

export const RecipientPage = z.strictObject({
  items: z.array(RecipientSummaryView).max(200),
  nextAfter: Uuid.nullable(),
});
export type RecipientPage = z.infer<typeof RecipientPage>;

export const RecipientParams = z.strictObject({ id: Uuid });
