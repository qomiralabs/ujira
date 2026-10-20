// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { ApprovalItem } from '../approvals.js';
import { Deposit, FundingOverview } from '../funding.js';
import { MandateDetail, MandateListItem } from '../mandates.js';
import { PayoutDetail, PayoutListItem } from '../payouts.js';
import { PrincipalReceipt, ReceiptListItem, RecipientReceipt } from '../receipts.js';
import type { FixtureSet } from './generate.js';
import { toMandateListItem, toPayoutListItem, toReceiptListItem } from './generate.js';

export interface FixtureFailure {
  readonly kind: string;
  readonly index: number;
  readonly issues: readonly string[];
}

/**
 * Parses every record in a fixture set with its schema and returns what
 * failed. Used by the tests and available to anyone extending the fixtures.
 */
export function checkFixtures(set: FixtureSet): FixtureFailure[] {
  const failures: FixtureFailure[] = [];
  const run = (
    kind: string,
    schema: {
      safeParse: (v: unknown) => {
        success: boolean;
        error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
    },
    rows: readonly unknown[],
  ): void => {
    rows.forEach((row, index) => {
      const result = schema.safeParse(row);
      if (!result.success) {
        failures.push({
          kind,
          index,
          issues: (result.error?.issues ?? []).map(
            (i) => `${i.path.map(String).join('.')}: ${i.message}`,
          ),
        });
      }
    });
  };
  run('MandateDetail', MandateDetail, set.mandates);
  run('MandateListItem', MandateListItem, set.mandates.map(toMandateListItem));
  run('PayoutDetail', PayoutDetail, set.payouts);
  run('PayoutListItem', PayoutListItem, set.payouts.map(toPayoutListItem));
  run('PrincipalReceipt', PrincipalReceipt, set.receipts);
  run('ReceiptListItem', ReceiptListItem, set.receipts.map(toReceiptListItem));
  run('RecipientReceipt', RecipientReceipt, set.recipientReceipts);
  run('FundingOverview', FundingOverview, set.funding);
  run('Deposit', Deposit, set.deposits);
  run('ApprovalItem', ApprovalItem, set.approvals);
  return failures;
}
