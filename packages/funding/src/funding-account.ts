// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Setting up a principal's own funding account, across the chain and the funding
// sources. Only a public key ever enters here, the secret stays in the wallet, and
// the schemas are strict so a secret sent by mistake is refused rather than carried.
//
// Confirming is safe to repeat, and has to be: the chain step and the funding
// source are two writes with a crash possible between them. A repeat finds the
// account already recorded and the source already made.
//
// This package knows no chain. Each network's flow comes from the chain adapter.

import { NETWORK_IDS } from '@ujira/chain-adapter';
import type {
  CallOptions,
  FundingAccountFlow,
  FundingAccountOptions,
  FundingAccountRecord,
  NetworkId,
  SigningRequest,
  SubmissionRef,
  TenantScope,
} from '@ujira/chain-adapter';
import { z } from 'zod';

import { FundingAccountStateError, FundingInputError } from './errors.js';
import { parsed } from './sweep.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ADDRESS = 128;
const MAX_ID = 128;
// A signed four operation transaction is far below this. It only bounds what is parsed.
const MAX_SIGNED = 16_384;

const uuid = z.string().regex(UUID);
const scope = z.strictObject({ principalId: uuid, projectId: uuid });
const network = z.enum(NETWORK_IDS);
const address = z.string().min(1).max(MAX_ADDRESS);
const id = z.string().min(1).max(MAX_ID);

const startSchema = z.strictObject({
  scope,
  network,
  publicKey: address,
  businessVerified: z.boolean(),
});
const submitSchema = z.strictObject({
  scope,
  network,
  requestId: id,
  signed: z.string().min(1).max(MAX_SIGNED),
  correlationId: id,
});
const confirmSchema = z.strictObject({
  scope,
  network,
  requestId: id,
  mandateInstanceId: uuid,
});
const attachSchema = z.strictObject({ scope, network, mandateInstanceId: uuid });
const optionsSchema = z.strictObject({ scope, network, mandate: address });

export interface StartFundingAccount {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  /** The public key the principal's wallet generated. Never a secret. */
  readonly publicKey: string;
  readonly businessVerified: boolean;
}

export interface SubmitFundingAccount {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly requestId: string;
  /** What the wallet signed. */
  readonly signed: string;
  readonly correlationId: string;
}

export interface ConfirmFundingAccount {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly requestId: string;
  /** The mandate instance the account was set up to fund. */
  readonly mandateInstanceId: string;
}

export interface ConfirmedFundingAccount {
  readonly account: FundingAccountRecord;
  /** Null when the account is not one to fund from: rejected, or held by another project. */
  readonly fundingSourceId: string | null;
}

export interface AttachFundingAccount {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly mandateInstanceId: string;
}

export interface FundingAccountOptionsRequest {
  readonly scope: TenantScope;
  readonly network: NetworkId;
  /** The mandate's address on that network. */
  readonly mandate: string;
}

/** Keeps one funding source per mandate instance, under the tenant's transaction. */
export interface FundingSourceStore {
  /**
   * The source's id, made the first time it is asked for. Null when this tenant
   * has no active account on the network, or the instance cannot use that one.
   */
  attach(
    scope: TenantScope,
    input: { readonly network: NetworkId; readonly mandateInstanceId: string },
  ): Promise<string | null>;
}

export interface FundingAccountServiceOptions {
  /** The flow for a network, or null where funding accounts are not offered. */
  readonly flowFor: (network: NetworkId) => FundingAccountFlow | null;
  readonly sources: FundingSourceStore;
}

export interface FundingAccountService {
  /** What the wallet signs. Nothing is reserved or sent yet. */
  start(req: StartFundingAccount, opts: CallOptions): Promise<SigningRequest>;
  submit(req: SubmitFundingAccount, opts: CallOptions): Promise<SubmissionRef>;
  /** Waits for the account, verifies it on chain and makes the instance's funding source. */
  confirm(req: ConfirmFundingAccount, opts: CallOptions): Promise<ConfirmedFundingAccount>;
  /** Points another mandate instance at the account the project already has. */
  attach(req: AttachFundingAccount): Promise<string>;
  /** The addresses to show for funding a mandate. */
  options(req: FundingAccountOptionsRequest): Promise<FundingAccountOptions>;
}

export function createFundingAccountService(
  options: FundingAccountServiceOptions,
): FundingAccountService {
  const { flowFor, sources } = options;

  const flowOf = (on: NetworkId): FundingAccountFlow => {
    const flow = flowFor(on);
    if (flow === null) throw new FundingInputError(['request.network (not_offered)']);
    return flow;
  };

  const sourceOf = async (req: AttachFundingAccount): Promise<string> => {
    const sourceId = await sources.attach(req.scope, {
      network: req.network,
      mandateInstanceId: req.mandateInstanceId,
    });
    if (sourceId === null) throw new FundingAccountStateError();
    return sourceId;
  };

  return {
    async start(req, opts) {
      parsed(startSchema, req, 'request');
      return flowOf(req.network).prepare(
        { scope: req.scope, publicKey: req.publicKey, businessVerified: req.businessVerified },
        opts,
      );
    },

    async submit(req, opts) {
      parsed(submitSchema, req, 'request');
      return flowOf(req.network).submit(
        {
          scope: req.scope,
          requestId: req.requestId,
          signed: req.signed,
          correlationId: req.correlationId,
        },
        opts,
      );
    },

    async confirm(req, opts) {
      parsed(confirmSchema, req, 'request');
      const account = await flowOf(req.network).confirm(
        { scope: req.scope, requestId: req.requestId },
        opts,
      );
      // A rejected account is on the record and flagged, but nothing is ever to
      // be funded from it. Another project's stays with that project.
      if (account.status !== 'active' || account.projectId !== req.scope.projectId) {
        return { account, fundingSourceId: null };
      }
      return { account, fundingSourceId: await sourceOf(req) };
    },

    async attach(req) {
      parsed(attachSchema, req, 'request');
      const account = await flowOf(req.network).account(req.scope);
      if (account?.status !== 'active') throw new FundingAccountStateError();
      return sourceOf(req);
    },

    async options(req) {
      parsed(optionsSchema, req, 'request');
      return flowOf(req.network).fundingOptions({ scope: req.scope, mandate: req.mandate });
    },
  };
}
