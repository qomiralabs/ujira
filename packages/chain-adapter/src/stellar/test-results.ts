// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Transaction results and metadata as the network writes them, for the
// adapter's unit tests. Test code only.

import { xdr } from '@stellar/stellar-sdk/base';

import type { ResourceFailure } from './soroban-rules.js';

function hostFunctionResult(failure: ResourceFailure | 'trapped'): xdr.OperationResult {
  const result = {
    resource_limit: () => xdr.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded(),
    entry_archived: () => xdr.InvokeHostFunctionResult.invokeHostFunctionEntryArchived(),
    trapped: () => xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
  }[failure]();
  return xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(result));
}

/** The failed result of a plain transaction. */
export function failedResult(failure: ResourceFailure | 'trapped'): string {
  return new xdr.TransactionResult({
    feeCharged: 100n,
    result: xdr.TransactionResultResult.txFailed([hostFunctionResult(failure)]),
    ext: xdr.TransactionResultExt.v0(),
  }).toXdr('base64');
}

/** The failed result of a sponsored transaction, with the failure inside the fee bump. */
export function failedFeeBumpResult(failure: ResourceFailure | 'trapped'): string {
  const inner = new xdr.InnerTransactionResult({
    feeCharged: 100n,
    result: xdr.InnerTransactionResultResult.txFailed([hostFunctionResult(failure)]),
    ext: xdr.InnerTransactionResultExt.v0(),
  });
  return new xdr.TransactionResult({
    feeCharged: 200n,
    result: xdr.TransactionResultResult.txFeeBumpInnerFailed(
      new xdr.InnerTransactionResultPair({
        transactionHash: new Uint8Array(32).fill(7),
        result: inner,
      }),
    ),
    ext: xdr.TransactionResultExt.v0(),
  }).toXdr('base64');
}

/** Metadata of a landed transaction that lists these entries as restored. */
export function restoredMeta(entries: readonly xdr.LedgerEntryData[]): string {
  const changes = entries.map((data) =>
    xdr.LedgerEntryChange.ledgerEntryRestored(
      new xdr.LedgerEntry({
        lastModifiedLedgerSeq: 1,
        data,
        ext: xdr.LedgerEntryExt.v0(),
      }),
    ),
  );
  return xdr.TransactionMeta.v4(
    new xdr.TransactionMetaV4({
      ext: xdr.ExtensionPoint.v0(),
      txChangesBefore: [],
      operations: [new xdr.OperationMetaV2({ ext: xdr.ExtensionPoint.v0(), changes, events: [] })],
      txChangesAfter: [],
      sorobanMeta: null,
      events: [],
      diagnosticEvents: [],
    }),
  ).toXdr('base64');
}
