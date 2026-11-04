// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a funding service asks of a chain to set up a principal's own funding
// account. Declared here rather than beside the one implementation, so the
// service and the chain module compile against the same contract and neither
// can drift from the other.

import type { NetworkId } from './networks.js';
import type {
  CallOptions,
  ChainAddress,
  SignedSubmission,
  SigningRequest,
  SubmissionRef,
  TenantScope,
} from './types.js';

/** One funding account as stored. Tenant on the row. */
export interface FundingAccountRecord {
  readonly principalId: string;
  readonly projectId: string;
  readonly network: NetworkId;
  readonly address: string;
  readonly sponsor: string;
  readonly sponsorTxHash: string;
  readonly status: 'active' | 'rejected';
  // Text, because a row can outlive the build that wrote it. A code this build
  // does not know still reads as a rejected account.
  readonly faults: readonly string[];
}

/** The addresses a principal may be shown for funding a mandate. */
export interface FundingAccountOptions {
  /** What to give an exchange or on-ramp. Null until a usable funding account exists. */
  readonly exchangeDeposit: ChainAddress | null;
  /** The mandate itself, only ever for funding from a wallet. */
  readonly walletFunding: { readonly address: ChainAddress; readonly label: string };
}

export interface PrepareFundingAccount {
  readonly scope: TenantScope;
  /** The public key the principal's wallet generated. Never a secret. */
  readonly publicKey: string;
  /** False while the principal is in business verification, which limits it to a test network. */
  readonly businessVerified: boolean;
}

/**
 * One funding account per principal and network, whichever project asked.
 * `forPrincipal` therefore reads across the principal's projects, and the record
 * says which one holds it. `record` keeps the first row written for a principal
 * and network, and throws if that row is not this one.
 */
export interface FundingAccountStore {
  forPrincipal(scope: TenantScope, network: NetworkId): Promise<FundingAccountRecord | null>;
  record(row: FundingAccountRecord): Promise<void>;
}

/** The flow over one network. */
export interface FundingAccountFlow {
  /** What the wallet signs. Nothing is reserved or sent yet. */
  prepare(req: PrepareFundingAccount, opts: CallOptions): Promise<SigningRequest>;
  /** Checks what the wallet signed, reserves the sponsorship, signs as the sponsor and sends. */
  submit(req: SignedSubmission, opts: CallOptions): Promise<SubmissionRef>;
  /** Waits for the transaction, reads the account back and records what it found. */
  confirm(
    req: { readonly scope: TenantScope; readonly requestId: string },
    opts: CallOptions,
  ): Promise<FundingAccountRecord>;
  /** This project's account on this network, in whatever state it is, or null. */
  account(scope: TenantScope): Promise<FundingAccountRecord | null>;
  /**
   * What to show for funding a mandate. Only an active account in this project
   * is ever offered as the exchange address, and the mandate never is.
   */
  fundingOptions(req: {
    readonly scope: TenantScope;
    readonly mandate: string;
  }): Promise<FundingAccountOptions>;
}
