// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the embed widget's routes take and return.

import { z } from 'zod';

import { Timestamp, Uuid } from './common.js';

// An exact origin, compared character for character with what a browser sends. Plain
// http is for a developer's own machine only.
const EmbedOrigin = z
  .string()
  .max(255)
  .refine((text) => {
    try {
      const url = new URL(text);
      if (url.origin !== text) return false;
      return (
        url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')
      );
    } catch {
      return false;
    }
  }, 'must be an https origin');

export const EmbedSessionRequest = z.strictObject({
  recipientId: Uuid,
  /** The pages the widget may run on, from 1 to 10. */
  allowedOrigins: z.array(EmbedOrigin).min(1).max(10),
  purpose: z.literal('onboarding'),
});
export type EmbedSessionRequest = z.infer<typeof EmbedSessionRequest>;

export const EmbedSessionCreated = z.strictObject({
  /** Shown once. Only its hash is stored. */
  embedToken: z.string().regex(/^ujes_(live|test)_[a-z2-7]{59}$/),
  expiresAt: Timestamp,
});
export type EmbedSessionCreated = z.infer<typeof EmbedSessionCreated>;

export const EmbedInviteCreated = z.strictObject({
  /** Shown once and good for one exchange. Only its hash is stored. */
  inviteSecret: z.string().regex(/^ujei_(live|test)_[a-z2-7]{59}$/),
  expiresAt: Timestamp,
});
export type EmbedInviteCreated = z.infer<typeof EmbedInviteCreated>;

export const EmbedInviteExchange = z.strictObject({
  inviteSecret: z.string().min(1).max(128),
});
export type EmbedInviteExchange = z.infer<typeof EmbedInviteExchange>;

export const EmbedRecipient = z.strictObject({
  recipientId: Uuid,
  purpose: z.string().min(1),
  expiresAt: Timestamp,
});
export type EmbedRecipient = z.infer<typeof EmbedRecipient>;
