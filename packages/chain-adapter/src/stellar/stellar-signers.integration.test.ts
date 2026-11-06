// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which threshold of a classic account authorizes a mandate call, measured on
// Stellar testnet against the deployed factory. A G principal acts through the
// adapter by signing its own transaction, which the sponsor fee bumps; it could
// also authorize a call someone else sends, through a signed auth entry. Both
// are tried with signer sets that meet one threshold and not another, so the
// gate counts signatures against the threshold the network really uses.
//
// Opt in with UJIRA_STELLAR_TESTNET=1; everywhere else it is skipped. Keys are
// testnet identities in the stellar CLI's store outside the repository, made on
// first use and funded by friendbot. They are held in memory and never printed.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  Account,
  Address,
  Keypair,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  hash,
  xdr,
} from '@stellar/stellar-base';
import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-base';
import { Keypair as SignerKeypair } from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { parseNetworksConfig } from '../config.js';
import { SignedPayloadMismatchError, SubmissionRejectedError } from '../errors.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import type {
  AdapterPorts,
  Bytes32,
  ChainAddress,
  MandateAction,
  MandateRef,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '../types.js';
import { addressXdr } from './address-xdr.js';
import { readStellarPrincipalSigning } from './account-signers.js';
import { createStellarLedgerReader } from './ledger-reader.js';
import { StellarMandateAdapter } from './mandate-adapter.js';
import { createMemorySigningRequestStore } from './requests.js';
import { createStellarRpc } from './rpc.js';
import type { RpcSendResult, StellarRpc } from './rpc.js';
import { keypairSigner, memoryStore, recordingSponsorship } from './test-ports.js';
import { PASSPHRASES } from './tx.js';

const ENABLED = process.env['UJIRA_STELLAR_TESTNET'] === '1';
const NETWORK = 'stellar:testnet' as const;
const PASSPHRASE = PASSPHRASES[NETWORK];
const RPC_URL = process.env['UJIRA_TESTNET_RPC_URL'] ?? 'https://soroban-testnet.stellar.org';
const CONFIG_DIR = path.join(
  process.env['UJIRA_TESTNET_HOME'] ?? path.join(homedir(), '.config/ujira-testnet'),
  'stellar',
);
const FRIENDBOT = 'https://friendbot.stellar.org/';
const CALL_TIMEOUT_MS = 30_000;

// The public record of the testnet deployment.
const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function cli(args: readonly string[]): string {
  return execFileSync('stellar', ['--config-dir', CONFIG_DIR, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: CALL_TIMEOUT_MS,
  }).trim();
}

// Its own identities, so changing this account's thresholds or spending the
// sponsor's sequence never collides with another testnet test.
function identity(name: string): Keypair {
  const full = `ujira-testnet-${name}`;
  try {
    cli(['keys', 'public-key', full]);
  } catch {
    cli(['keys', 'generate', full]);
  }
  return Keypair.fromSecret(cli(['keys', 'secret', full]));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const at = (key: Keypair | string): ChainAddress => ({
  network: NETWORK,
  value: typeof key === 'string' ? key : key.publicKey(),
});

const usdc = (units: bigint) => tokenAmount(units * 10_000_000n, 'USDC', 'stellar');

/** Why a transaction failed, down to the operation, or SUCCESS. */
function outcomeOf(status: string, resultXdr: string | undefined): string {
  if (status === 'SUCCESS') return 'SUCCESS';
  if (resultXdr === undefined) return status;
  const outer = xdr.TransactionResult.fromXDR(resultXdr, 'base64').result();
  // A fee bump's own result only says the inner transaction failed.
  const result: {
    switch(): { readonly name: string };
    results(): xdr.OperationResult[];
  } =
    outer.switch().name === 'txFeeBumpInnerFailed'
      ? outer.innerResultPair().result().result()
      : outer;
  if (result.switch().name !== 'txFailed') return result.switch().name;
  const [op] = result.results();
  if (op === undefined) return 'txFailed';
  if (op.switch().name !== 'opInner') return op.switch().name;
  return op.tr().value().switch().name;
}

interface AccountState {
  readonly sequence: bigint;
  readonly masterWeight: number;
  readonly high: number;
  readonly signers: ReadonlyMap<string, number>;
}

/**
 * An address credential signed by each key, in ascending order of public key as
 * the host requires, each as the { public_key, signature } map it reads.
 */
function signEntry(
  entry: xdr.SorobanAuthorizationEntry,
  keys: readonly Keypair[],
  expirationLedger: number,
): xdr.SorobanAuthorizationEntry {
  const credentials = entry.credentials().address();
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(PASSPHRASE)),
      nonce: credentials.nonce(),
      signatureExpirationLedger: expirationLedger,
      invocation: entry.rootInvocation(),
    }),
  );
  const payload = hash(preimage.toXDR());
  const sorted = [...keys].sort((x, y) => Buffer.compare(x.rawPublicKey(), y.rawPublicKey()));
  const signature = xdr.ScVal.scvVec(
    sorted.map((key) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('public_key'),
          val: xdr.ScVal.scvBytes(key.rawPublicKey()),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('signature'),
          val: xdr.ScVal.scvBytes(key.sign(payload)),
        }),
      ]),
    ),
  );
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: credentials.address(),
        nonce: credentials.nonce(),
        signatureExpirationLedger: expirationLedger,
        signature,
      }),
    ),
    rootInvocation: entry.rootInvocation(),
  });
}

function harness(sponsor: Keypair, channel: Keypair) {
  const clock = () => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
  const scope: TenantScope = {
    principalId: randomUUID() as Uuid,
    projectId: randomUUID() as Uuid,
  };
  const config = parseNetworksConfig({
    [NETWORK]: {
      enabled: true,
      rpc: [{ url: 'secretRef:testnet_rpc', weight: 1 }],
      maxEndpointLagSeconds: 60,
      explorer: { tx: 'https://stellar.expert/explorer/testnet/tx/{hash}' },
      health: {
        maxHeadLagSeconds: 60,
        degradedErrorBps: 500,
        downErrorBps: 2000,
        hysteresisChecks: 3,
      },
      trustedFactories: { '1': [FACTORY] },
      assets: { USDC: { sac: USDC_SAC, issuer: USDC_ISSUER } },
      deposits: { startLedger: 0, availableAt: 'final', pageEvents: 100 },
      executor: {
        txValiditySeconds: 120,
        keys: [{ provider: 'local', keyId: 'channel-1', address: channel.publicKey() }],
      },
      feeSponsor: {
        perPrincipalFundingAccounts: 1,
        reserveSponsorshipDailyStroops: '100000000',
        maxFeePerTxStroops: '20000000',
        perPrincipalPerMinute: 60,
        perPrincipalDailyCount: 1000,
        perPrincipalDailyFeeStroops: '100000000',
        globalDailyFeeStroops: '1000000000',
        lowBalanceStroops: '100000000',
        minBalanceStroops: '10000000',
        key: { provider: 'local', keyId: 'sponsor', address: sponsor.publicKey() },
      },
      sep10: [],
      signingWindowSeconds: 600,
    },
  });
  const ports: AdapterPorts = {
    store: memoryStore(NETWORK, [{ address: channel.publicKey(), keyId: 'channel-1' }], clock),
    // The deployed record stands in for the indexer, which is not part of this test.
    registry: {
      registered: (network, contractId) =>
        Promise.resolve({
          network,
          contractId,
          factory: FACTORY,
          tenantTag: tenantTagOf(tenantRefOf(scope), addressXdr(contractId)),
          flagged: false,
        }),
      claimedAt: () => Promise.resolve(null),
    },
    signer: keypairSigner(
      NETWORK,
      // The signer port takes the SDK's own key class.
      new Map([
        ['fee_sponsor', SignerKeypair.fromSecret(sponsor.secret())],
        ['executor:channel-1', SignerKeypair.fromSecret(channel.secret())],
      ]),
    ),
    sponsorship: recordingSponsorship(),
    alerts: {
      lowBalance: () => undefined,
      stuck: () => undefined,
      divergence: () => undefined,
      batch: () => undefined,
    },
    clock: { nowSeconds: clock },
    config: () => config,
  };
  const base = createStellarRpc({ network: NETWORK, url: RPC_URL, timeoutMs: CALL_TIMEOUT_MS });
  // The adapter reports a refused send as SubmissionRejectedError alone, so the
  // network's own answer is kept here to say why.
  const sends: RpcSendResult[] = [];
  const rpc: StellarRpc = {
    getEvents: (request, o) => base.getEvents(request, o),
    getLatestLedger: (o) => base.getLatestLedger(o),
    getLedgerEntries: (keys, o) => base.getLedgerEntries(keys, o),
    simulateTransaction: (tx, o) => base.simulateTransaction(tx, o),
    getTransaction: (txHash, o) => base.getTransaction(txHash, o),
    sendTransaction: async (tx, o) => {
      const sent = await base.sendTransaction(tx, o);
      sends.push(sent);
      return sent;
    },
  };
  const requests = createMemorySigningRequestStore();
  const adapter = new StellarMandateAdapter({ network: NETWORK, rpc, ports, requests });
  const opts = { correlationId: `it-${randomUUID()}` };
  const record: string[] = [];

  async function readAccount(address: string): Promise<AccountState | null> {
    const key = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
    ).toXDR('base64');
    const { entries } = await rpc.getLedgerEntries([key], opts);
    const [entry] = entries;
    if (entry === undefined) return null;
    const account = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64').account();
    return {
      sequence: BigInt(account.seqNum().toString()),
      masterWeight: account.thresholds()[0] ?? 0,
      high: account.thresholds()[3] ?? 0,
      signers: new Map(
        account
          .signers()
          .map((s) => [StrKey.encodeEd25519PublicKey(s.key().ed25519()), s.weight()] as const),
      ),
    };
  }

  async function funded(key: Keypair): Promise<AccountState> {
    const known = await readAccount(key.publicKey());
    if (known !== null) return known;
    const response = await fetch(`${FRIENDBOT}?addr=${key.publicKey()}`, {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`friendbot answered ${String(response.status)}`);
    const made = await readAccount(key.publicKey());
    if (made === null) throw new Error('friendbot did not fund the account');
    return made;
  }

  async function outcome(label: string, txHash: string): Promise<string> {
    for (let i = 0; i < 40; i += 1) {
      const tx = await rpc.getTransaction(txHash, opts);
      if (tx.status !== 'NOT_FOUND') {
        const result = outcomeOf(tx.status, tx.resultXdr);
        record.push(`${label}: ${txHash} ${result}`);
        return result;
      }
      await sleep(2000);
    }
    throw new Error(`${label} did not land`);
  }

  async function send(label: string, tx: Transaction | FeeBumpTransaction): Promise<string> {
    const sent = await rpc.sendTransaction(tx.toEnvelope().toXDR('base64'), opts);
    if (sent.status === 'ERROR') {
      const result = outcomeOf('ERROR', sent.errorResultXdr);
      record.push(`${label}: ${sent.hash} refused ${result}`);
      return result;
    }
    return outcome(label, sent.hash);
  }

  /**
   * Gives the principal its extra signers at weight 1 and these thresholds,
   * master weight 1 unless given. Signed by keys the account lists now, only
   * until they reach its high threshold: the network refuses a signature it did
   * not need.
   */
  async function layout(
    label: string,
    principal: Keypair,
    others: readonly Keypair[],
    thresholds: {
      readonly low: number;
      readonly medium: number;
      readonly high: number;
      readonly master?: number;
    },
  ): Promise<string> {
    const state = await funded(principal);
    const builder = new TransactionBuilder(
      new Account(principal.publicKey(), state.sequence.toString()),
      { fee: '1000', networkPassphrase: PASSPHRASE },
    );
    for (const other of others) {
      builder.addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: other.publicKey(), weight: 1 } }),
      );
    }
    builder.addOperation(
      Operation.setOptions({
        masterWeight: thresholds.master ?? 1,
        lowThreshold: thresholds.low,
        medThreshold: thresholds.medium,
        highThreshold: thresholds.high,
      }),
    );
    const tx = builder.setTimeout(120).build();
    const listed: [Keypair, number][] = [
      [principal, state.masterWeight],
      ...others.map((other): [Keypair, number] => [
        other,
        state.signers.get(other.publicKey()) ?? 0,
      ]),
    ];
    let weight = 0;
    for (const [key, keyWeight] of listed) {
      if (keyWeight === 0 || weight >= Math.max(state.high, 1)) continue;
      tx.sign(key);
      weight += keyWeight;
    }
    return send(label, tx);
  }

  /** A mandate action through the adapter: the principal's own transaction, fee bumped. */
  async function viaTransaction(
    label: string,
    principal: Keypair,
    mandate: MandateRef | null,
    action: MandateAction,
    keys: readonly Keypair[],
  ): Promise<{
    readonly result: string;
    readonly requestId: string;
    readonly adapter: 'accepted' | 'refused';
  }> {
    const request = await adapter.prepareMandateAction(
      {
        scope,
        mandate,
        action,
        signer: { kind: 'external', network: NETWORK, role: 'principal', address: at(principal) },
      },
      opts,
    );
    if (request.kind !== 'stellar_transaction') throw new Error(`asked for ${request.kind}`);
    const tx = TransactionBuilder.fromXDR(request.xdr, PASSPHRASE) as Transaction;
    for (const key of keys) tx.sign(key);
    const before = sends.length;
    try {
      const ref = await adapter.submitSigned(
        {
          scope,
          requestId: request.requestId,
          signed: tx.toEnvelope().toXDR('base64'),
          correlationId: opts.correlationId,
        },
        opts,
      );
      const result = await outcome(label, ref.txHash);
      return { result, requestId: request.requestId, adapter: 'accepted' };
    } catch (error) {
      if (error instanceof SignedPayloadMismatchError) {
        // The adapter refused it before the sponsor paid. The same transaction
        // goes to the network anyway, fee bumped here, so the run still shows
        // what the network says of these signatures.
        const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, tx.fee, tx, PASSPHRASE);
        bump.sign(sponsor);
        const result = await send(`${label}, refused by the adapter, sent directly`, bump);
        return { result, requestId: request.requestId, adapter: 'refused' };
      }
      const refused = sends.length > before ? sends.at(-1) : undefined;
      if (!(error instanceof SubmissionRejectedError) || refused?.status !== 'ERROR') throw error;
      // Refused before it reached a ledger: the hash is the fee bump's, never on chain.
      const result = outcomeOf('ERROR', refused.errorResultXdr);
      record.push(`${label}: ${refused.hash} refused ${result}`);
      return { result, requestId: request.requestId, adapter: 'accepted' };
    }
  }

  /**
   * A principal-only call sent by another account, the principal authorizing it
   * through an auth entry signed by `keys`. Resources come from a simulation
   * with every key signing, which reads the account the host checks, so the
   * call lands either way and the result is the host's own answer.
   */
  async function viaEntry(
    label: string,
    sender: Keypair,
    principal: Keypair,
    every: readonly Keypair[],
    mandate: string,
    fn: 'pause' | 'resume',
    keys: readonly Keypair[],
  ): Promise<string> {
    const source = await funded(sender);
    const build = (auth: xdr.SorobanAuthorizationEntry[], fee = '100') =>
      new TransactionBuilder(new Account(sender.publicKey(), source.sequence.toString()), {
        fee,
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: mandate,
            function: fn,
            args: [new Address(principal.publicKey()).toScVal()],
            auth,
          }),
        )
        .setTimeout(120);
    const recorded = await rpc.simulateTransaction(build([]).build().toXDR(), opts);
    const entryXdr = recorded.results?.[0]?.auth?.[0];
    if (recorded.error !== undefined || entryXdr === undefined) {
      throw new Error(`${label}: the simulation gave no auth entry`);
    }
    const unsigned = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
    const expiration = recorded.latestLedger + 100;
    const sized = await rpc.simulateTransaction(
      build([signEntry(unsigned, every, expiration)])
        .build()
        .toXDR(),
      opts,
    );
    if (sized.error !== undefined || sized.transactionData === undefined) {
      throw new Error(`${label}: the signed simulation failed`);
    }
    const data = new SorobanDataBuilder(sized.transactionData);
    const resources = data.build().resources();
    const resourceFee = BigInt(sized.minResourceFee ?? '0') + 1_000_000n;
    data
      .setResources(
        resources.instructions() + 1_000_000,
        resources.diskReadBytes(),
        resources.writeBytes(),
      )
      .setResourceFee(resourceFee);
    const tx = build([signEntry(unsigned, keys, expiration)], String(resourceFee + 1000n))
      .setSorobanData(data.build())
      .build();
    tx.sign(sender);
    return send(label, tx);
  }

  function createAction(principal: Keypair, agent: Keypair, approver: Keypair): MandateAction {
    return {
      op: 'create',
      factory: at(FACTORY),
      salt: `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}` as Bytes32,
      config: {
        principal: at(principal),
        asset: 'USDC',
        recipientMode: 'allowlist',
        agents: [at(agent)],
        approvers: [at(approver)],
        approvalsRequired: 1,
        guardians: [],
        executors: [],
        recovery: [],
        recoveryThreshold: 0,
        limits: {
          totalBudget: usdc(1000n),
          perPaymentCap: usdc(100n),
          perRecipientDailyCap: usdc(200n),
          approvalThreshold: usdc(10n),
          payoutTtlSeconds: 86_400,
          expiresAt: (clock() + 30n * 86_400n) as UnixSeconds,
        },
        attester: null,
        countryPolicyHash: `0x${'0'.repeat(64)}` as Bytes32,
        maxFeeBps: 100,
      },
    };
  }

  async function created(requestId: string): Promise<MandateRef> {
    const stored = await requests.load(scope, requestId);
    const address = stored?.request.mandate ?? '';
    expect(address).toMatch(/^C/);
    return { network: NETWORK, address: at(address), specVersion: 1 };
  }

  return {
    rpc,
    opts,
    record,
    funded,
    layout,
    viaTransaction,
    viaEntry,
    createAction,
    created,
  };
}

describe.skipIf(!ENABLED)('stellar-signers.integration.test.ts', () => {
  it('a classic account principal authorizes a mandate call at its medium threshold', async () => {
    const principal = identity('threshold-principal');
    const a = identity('threshold-signer-a');
    const b = identity('threshold-signer-b');
    const sponsor = identity('threshold-sponsor');
    const sender = identity('threshold-sender');
    const agent = identity('smoke-agent');
    const approver = identity('smoke-approver');
    const h = harness(sponsor, sender);
    await h.funded(sponsor);
    await h.funded(sender);
    const every = [principal, a, b];

    // Medium 2 sits between low 1 and high 3. One signature meets only low;
    // two meet low and medium, and not high.
    expect(await h.layout('layout 1/2/3', principal, [a, b], { low: 1, medium: 2, high: 3 })).toBe(
      'SUCCESS',
    );
    const create = h.createAction(principal, agent, approver);
    const one = await h.viaTransaction('create, own tx, weight 1', principal, null, create, [
      principal,
    ]);
    const two = await h.viaTransaction('create, own tx, weight 2', principal, null, create, [
      principal,
      a,
    ]);
    const mandate = await h.created(two.requestId);
    const id = mandate.address.value;
    const entryOne = await h.viaEntry(
      'pause, entry, weight 1',
      sender,
      principal,
      every,
      id,
      'pause',
      [principal],
    );
    const entryTwo = await h.viaEntry(
      'pause, entry, weight 2',
      sender,
      principal,
      every,
      id,
      'pause',
      [principal, a],
    );

    // Medium 3 now equals high, so two signatures meet only low.
    expect(await h.layout('layout 1/3/3', principal, [a, b], { low: 1, medium: 3, high: 3 })).toBe(
      'SUCCESS',
    );
    const resumeTwo = await h.viaTransaction(
      'resume, own tx, weight 2',
      principal,
      mandate,
      { op: 'resume' },
      [principal, a],
    );
    const resumeThree = await h.viaTransaction(
      'resume, own tx, weight 3',
      principal,
      mandate,
      { op: 'resume' },
      every,
    );
    const entryTwoAgain = await h.viaEntry(
      'pause, entry, weight 2 of 3',
      sender,
      principal,
      every,
      id,
      'pause',
      [principal, a],
    );
    const entryThree = await h.viaEntry(
      'pause, entry, weight 3',
      sender,
      principal,
      every,
      id,
      'pause',
      every,
    );

    // Back to the 2 of 3 layout, which the reader must call a multisig, and the
    // sender's default account, whose master key alone meets every threshold.
    expect(
      await h.layout('layout 1/2/3 again', principal, [a, b], { low: 1, medium: 2, high: 3 }),
    ).toBe('SUCCESS');
    const reader = createStellarLedgerReader(h.rpc);
    const twoOfThree = await readStellarPrincipalSigning(
      reader,
      NETWORK,
      principal.publicKey(),
      h.opts,
    );
    const single = await readStellarPrincipalSigning(reader, NETWORK, sender.publicKey(), h.opts);

    // The hashes are public, and go on the issue as the record of the run.
    process.stdout.write(
      [`principal ${principal.publicKey()}, mandate ${id}`, ...h.record, ''].join('\n'),
    );
    const ownTx = [one, two, resumeTwo, resumeThree];
    expect({
      ownTx: ownTx.map((r) => r.result),
      adapter: ownTx.map((r) => r.adapter),
      entry: [entryOne, entryTwo, entryTwoAgain, entryThree],
    }).toEqual({
      // Short of the operation's threshold, the network fails the operation.
      ownTx: ['opBadAuth', 'SUCCESS', 'opBadAuth', 'SUCCESS'],
      // And the adapter refuses exactly those, before the sponsor pays.
      adapter: ['refused', 'accepted', 'refused', 'accepted'],
      // Short of it in an auth entry, the host traps the call.
      entry: ['invokeHostFunctionTrapped', 'SUCCESS', 'invokeHostFunctionTrapped', 'SUCCESS'],
    });
    expect(twoOfThree).toEqual({ kind: 'multisig', minSignatures: 2 });
    expect(single).toEqual({ kind: 'single_key' });
  }, 900_000);

  it('a 2 of 3 principal with its master key off acts through the adapter', async () => {
    const principal = identity('threshold-multisig');
    const a = identity('threshold-signer-a');
    const b = identity('threshold-signer-b');
    const c = identity('threshold-signer-c');
    const sponsor = identity('threshold-sponsor');
    const sender = identity('threshold-sender');
    const agent = identity('smoke-agent');
    const approver = identity('smoke-approver');
    const h = harness(sponsor, sender);
    await h.funded(sponsor);

    // Master weight 0: only the three signers can sign, any two of them.
    expect(
      await h.layout('layout master 0, 1/2/2', principal, [a, b, c], {
        low: 1,
        medium: 2,
        high: 2,
        master: 0,
      }),
    ).toBe('SUCCESS');
    const create = h.createAction(principal, agent, approver);
    const created = await h.viaTransaction('create, signed by a and b', principal, null, create, [
      a,
      b,
    ]);
    const mandate = await h.created(created.requestId);
    const one = await h.viaTransaction(
      'pause, signed by a alone',
      principal,
      mandate,
      { op: 'pause' },
      [a],
    );
    const paused = await h.viaTransaction(
      'pause, signed by a and c',
      principal,
      mandate,
      { op: 'pause' },
      [a, c],
    );
    const resumed = await h.viaTransaction(
      'resume, signed by b and c',
      principal,
      mandate,
      { op: 'resume' },
      [b, c],
    );
    const signing = await readStellarPrincipalSigning(
      createStellarLedgerReader(h.rpc),
      NETWORK,
      principal.publicKey(),
      h.opts,
    );

    process.stdout.write(
      [
        `principal ${principal.publicKey()}, mandate ${mandate.address.value}`,
        ...h.record,
        '',
      ].join('\n'),
    );
    const calls = [created, one, paused, resumed];
    expect({
      result: calls.map((r) => r.result),
      adapter: calls.map((r) => r.adapter),
    }).toEqual({
      result: ['SUCCESS', 'opBadAuth', 'SUCCESS', 'SUCCESS'],
      adapter: ['accepted', 'refused', 'accepted', 'accepted'],
    });
    expect(signing).toEqual({ kind: 'multisig', minSignatures: 2 });
  }, 900_000);
});
