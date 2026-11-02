// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What UJIRA answers a provider that delivered a genuine webhook. A provider
// retries anything but a success, so every genuine delivery gets one, whether
// or not it changed anything.

import { z } from 'zod';

export const SELF_WEBHOOK_RESULTS = Object.freeze([
  'applied',
  'duplicate',
  'stale',
  'ignored',
] as const);

export const SelfWebhookAck = z.strictObject({ result: z.enum(SELF_WEBHOOK_RESULTS) });
export type SelfWebhookAck = z.infer<typeof SelfWebhookAck>;
