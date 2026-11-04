// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Writing and activating versions. Both validate, so a document that fails
// today's schema is refused when it is written and again when someone tries
// to make it live, for instance a version written before the schema moved.

import { parseRoutingConfig } from './config.js';
import { RoutingConfigInvalidError, RoutingConfigVersionNotFoundError } from './errors.js';
import type { RoutingConfigStore } from './store.js';
import { STORE_TIMEOUT_MS, callStore } from './timeout.js';

// A service, a runbook or an opaque operator ID. Names and email addresses are
// personal data and stay out of configuration history. The same format as the
// check on the column, so a document that passes here cannot fail on insert.
const OPERATOR_ID = /^[a-z0-9_.:-]{1,64}$/;

export interface AdminOptions {
  readonly timeoutMs?: number;
}

/**
 * Validates a document and stores it as a new, inactive version. Throws
 * RoutingConfigInvalidError before anything is written when it is invalid.
 */
export async function publishRoutingConfig(
  store: RoutingConfigStore,
  input: { readonly document: unknown; readonly createdBy: string },
  options: AdminOptions = {},
): Promise<{ readonly version: number }> {
  if (!OPERATOR_ID.test(input.createdBy)) {
    throw new RoutingConfigInvalidError(['createdBy (invalid_format)']);
  }
  parseRoutingConfig(input.document);
  const { document, createdBy } = input;
  return callStore(
    (opts) => store.insertVersion({ document, createdBy }, opts),
    options.timeoutMs ?? STORE_TIMEOUT_MS,
  );
}

/**
 * Makes a stored version the active one, after validating it again. Every
 * service picks it up on its next poll. Rolling back is activating an
 * older version.
 */
export async function activateRoutingConfig(
  store: RoutingConfigStore,
  version: number,
  options: AdminOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? STORE_TIMEOUT_MS;
  const record = await callStore((opts) => store.getVersion(version, opts), timeoutMs);
  if (record === null) throw new RoutingConfigVersionNotFoundError();
  parseRoutingConfig(record.document);
  await callStore((opts) => store.activate(version, opts), timeoutMs);
}
