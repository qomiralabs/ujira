// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs the mandate against a local Stellar network that this test sets up from
// nothing. It funds its own accounts from the network's root account, issues a
// test USDC, uploads the mandate and factory wasm from fixtures/contracts (the
// bytes deployed on testnet) and deploys a factory, then drives a mandate through
// the adapter as a principal would.
//
// Start the network with scripts/stellar-local.sh up and set UJIRA_STELLAR_LOCAL_RPC
// to the URL it prints. Without it the test is skipped, the pull request checks
// included.
//
// The network runs with testnet's passphrase, because the adapter signs for the
// networks it knows and no other. So this refuses any RPC URL that is not on the
// loopback address: the root key is derived from the passphrase, which anyone can
// do, and must only ever be used on a network this machine runs. Every other key is
// made fresh for the run and never leaves memory.

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  Account,
  Address,
  Asset,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  hash,
  xdr,
} from '@stellar/stellar-sdk/base';
import type { Transaction } from '@stellar/stellar-sdk/base';
import { assembleTransaction } from '@stellar/stellar-sdk/rpc';
import { tokenAmount } from '@ujira/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseNetworksConfig } from '../config.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import type {
  AdapterPorts,
  Bytes32,
  ChainAddress,
  MandateAction,
  MandateRef,
  SigningRequest,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '../types.js';
import { addressXdr } from './address-xdr.js';
import { StellarMandateAdapter } from './mandate-adapter.js';
import { createMemorySigningRequestStore } from './requests.js';
import { createStellarRpc } from './rpc.js';
import type { StellarRpc } from './rpc.js';
import { keypairSigner, memoryStore, recordingSponsorship } from './test-ports.js';
import { PASSPHRASES, accountSequence, waitForTransaction } from './tx.js';

const RPC_URL = process.env['UJIRA_STELLAR_LOCAL_RPC'] ?? '';
const ENABLED = RPC_URL !== '';
const NETWORK = 'stellar:testnet' as const;
const PASSPHRASE = PASSPHRASES[NETWORK];
const FIXTURES = path.join(import.meta.dirname, '../../fixtures/contracts');
const OPTS = { correlationId: `local-${randomUUID()}` };
// Ledgers close slowly on a capped network on a busy machine, so this waits longer
// than a live network would need.
const WAIT = {
  attempts: 120,
  intervalMs: 2000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const at = (key: Keypair | string): ChainAddress => ({
  network: NETWORK,
  value: typeof key === 'string' ? key : key.publicKey(),
});

const usdc = (units: bigint) => tokenAmount(units * 10_000_000n, 'USDC', 'stellar');

function localRpc(url: string): StellarRpc {
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host))
    throw new Error(`UJIRA_STELLAR_LOCAL_RPC is not a local address: ${host}`);
  return createStellarRpc({ network: NETWORK, url, timeoutMs: 30_000 });
}

async function landed(rpc: StellarRpc, tx: Transaction, label: string): Promise<string> {
  const sent = await rpc.sendTransaction(tx.toXdr(), OPTS);
  if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
    throw new Error(`${label}: ${sent.status} ${sent.errorResultXdr ?? ''}`);
  }
  const result = await waitForTransaction(rpc, NETWORK, sent.hash, WAIT, OPTS).catch(
    (error: unknown) => {
      throw new Error(`${label}: not seen on the network`, { cause: error });
    },
  );
  if (result.status !== 'SUCCESS') throw new Error(`${label}: ${result.status}`);
  return sent.hash;
}

async function build(rpc: StellarRpc, source: Keypair, ops: readonly xdr.Operation[]) {
  const sequence = await accountSequence(rpc, source.publicKey(), OPTS);
  if (sequence === null) throw new Error(`no account ${source.publicKey()}`);
  const builder = new TransactionBuilder(new Account(source.publicKey(), sequence.toString()), {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  });
  for (const op of ops) builder.addOperation(op);
  return builder.setTimeout(120).build();
}

/** A classic transaction, signed by its source and by the source of each operation. */
async function classic(
  rpc: StellarRpc,
  source: Keypair,
  ops: readonly xdr.Operation[],
  signers: readonly Keypair[],
  label: string,
): Promise<string> {
  const tx = await build(rpc, source, ops);
  for (const signer of [source, ...signers]) tx.sign(signer);
  return landed(rpc, tx, label);
}

/** One host function, simulated for its footprint and fee, then sent. */
async function invoke(
  rpc: StellarRpc,
  source: Keypair,
  op: xdr.Operation,
  label: string,
): Promise<string> {
  const tx = await build(rpc, source, [op]);
  const simulated = await rpc.simulateTransaction(tx.toXdr(), OPTS);
  if (simulated.error !== undefined) throw new Error(`${label}: ${simulated.error}`);
  const ready = assembleTransaction(tx, simulated).build();
  ready.sign(source);
  return landed(rpc, ready, label);
}

function contractIdFor(deployer: Keypair, salt: Buffer): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(PASSPHRASE)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(deployer.publicKey()).toScAddress(),
          salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXdr()));
}

const ROLES = ['deployer', 'fee', 'issuer', 'principal', 'agent', 'approver', 'channel'] as const;
type Role = (typeof ROLES)[number];

interface LocalDeployment {
  readonly rpc: StellarRpc;
  readonly keys: Readonly<Record<Role, Keypair>>;
  readonly factory: string;
  readonly usdc: { readonly sac: string; readonly issuer: string };
  readonly hashes: [string, string][];
}

/** Everything a factory needs on a network that holds nothing yet. */
async function deploy(rpc: StellarRpc): Promise<LocalDeployment> {
  const hashes: [string, string][] = [];
  const keep = async (label: string, sent: Promise<string>) => {
    hashes.push([label, await sent]);
  };
  const root = Keypair.master(PASSPHRASE);
  const keys = Object.fromEntries(ROLES.map((role) => [role, Keypair.random()])) as Record<
    Role,
    Keypair
  >;
  await keep(
    'fund_accounts',
    classic(
      rpc,
      root,
      ROLES.map((role) =>
        Operation.createAccount({ destination: keys[role].publicKey(), startingBalance: '1000' }),
      ),
      [],
      'fund accounts',
    ),
  );

  const asset = new Asset('USDC', keys.issuer.publicKey());
  const holders = [keys.fee, keys.principal];
  await keep(
    'usdc_trust_and_issue',
    classic(
      rpc,
      keys.deployer,
      [
        ...holders.map((h) => Operation.changeTrust({ asset, source: h.publicKey() })),
        Operation.payment({
          destination: keys.principal.publicKey(),
          asset,
          amount: '1000',
          source: keys.issuer.publicKey(),
        }),
      ],
      [...holders, keys.issuer],
      'trust and issue USDC',
    ),
  );
  await keep(
    'wrap_usdc',
    invoke(rpc, keys.deployer, Operation.createStellarAssetContract({ asset }), 'wrap USDC'),
  );
  const sac = asset.contractId(PASSPHRASE);

  const mandateWasm = readFileSync(path.join(FIXTURES, 'ujira_mandate.wasm'));
  const factoryWasm = readFileSync(path.join(FIXTURES, 'ujira_factory.wasm'));
  for (const [label, wasm] of [
    ['upload_mandate', mandateWasm],
    ['upload_factory', factoryWasm],
  ] as const) {
    await keep(label, invoke(rpc, keys.deployer, Operation.uploadContractWasm({ wasm }), label));
  }
  const salt = randomBytes(32);
  await keep(
    'deploy_factory',
    invoke(
      rpc,
      keys.deployer,
      Operation.createCustomContract({
        address: new Address(keys.deployer.publicKey()),
        wasmHash: hash(factoryWasm),
        salt,
        constructorArgs: [
          xdr.ScVal.scvBytes(hash(mandateWasm)),
          xdr.ScVal.scvVec([new Address(sac).toScVal()]),
          new Address(keys.fee.publicKey()).toScVal(),
        ],
      }),
      'deploy factory',
    ),
  );
  return {
    rpc,
    keys,
    factory: contractIdFor(keys.deployer, salt),
    usdc: { sac, issuer: keys.issuer.publicKey() },
    hashes,
  };
}

async function walletSign(request: SigningRequest, key: Keypair): Promise<string> {
  if (request.kind === 'stellar_transaction') {
    const tx = TransactionBuilder.fromXdr(request.xdr, PASSPHRASE);
    tx.sign(key);
    return tx.toXdr();
  }
  const entry = xdr.SorobanAuthorizationEntry.fromXdr(request.entryXdr, 'base64');
  return (await authorizeEntry(entry, key, request.expirationLedger, PASSPHRASE)).toXdr('base64');
}

function harness(d: LocalDeployment) {
  const { keys } = d;
  // The deployer pays for the fee bumps here, as the sponsor would.
  const sponsor = keys.deployer;
  const channel = keys.channel;
  const clock = () => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
  const config = parseNetworksConfig({
    [NETWORK]: {
      enabled: true,
      rpc: [{ url: 'secretRef:local_rpc', weight: 1 }],
      maxEndpointLagSeconds: 60,
      explorer: { tx: 'https://stellar.expert/explorer/testnet/tx/{hash}' },
      health: {
        maxHeadLagSeconds: 60,
        degradedErrorBps: 500,
        downErrorBps: 2000,
        hysteresisChecks: 3,
      },
      trustedFactories: { '1': [d.factory] },
      assets: { USDC: d.usdc },
      deposits: { startLedger: 0, availableAt: 'final', pageEvents: 100 },
      executor: {
        txValiditySeconds: 120,
        keys: [{ provider: 'local', keyId: 'channel-1', address: channel.publicKey() }],
      },
      feeSponsor: {
        perPrincipalFundingAccounts: 1,
        reserveSponsorshipDailyStroops: '100000000',
        // A local network's resource fees are not testnet's, and this test is not about
        // the fee caps, so they are set where no call here can reach them.
        maxFeePerTxStroops: '1000000000',
        perPrincipalPerMinute: 60,
        perPrincipalDailyCount: 1000,
        perPrincipalDailyFeeStroops: '1000000000',
        globalDailyFeeStroops: '5000000000',
        lowBalanceStroops: '100000000',
        minBalanceStroops: '10000000',
        key: { provider: 'local', keyId: 'sponsor', address: sponsor.publicKey() },
      },
      sep10: [],
      signingWindowSeconds: 600,
    },
  });
  const scope: TenantScope = { principalId: randomUUID() as Uuid, projectId: randomUUID() as Uuid };
  const store = memoryStore(NETWORK, [{ address: channel.publicKey(), keyId: 'channel-1' }], clock);
  const ports: AdapterPorts = {
    store,
    // Stands in for the indexer, which is not part of this test.
    registry: {
      registered: (network, contractId) =>
        Promise.resolve({
          network,
          contractId,
          factory: d.factory,
          tenantTag: tenantTagOf(tenantRefOf(scope), addressXdr(contractId)),
          flagged: false,
        }),
      claimedAt: () => Promise.resolve(null),
    },
    signer: keypairSigner(
      NETWORK,
      new Map([
        ['fee_sponsor', sponsor],
        ['executor:channel-1', channel],
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
  const requests = createMemorySigningRequestStore();
  const adapter = new StellarMandateAdapter({ network: NETWORK, rpc: d.rpc, ports, requests });

  async function submit(label: string, request: SigningRequest, key: Keypair): Promise<void> {
    const ref = await adapter.submitSigned(
      {
        scope,
        requestId: request.requestId,
        signed: await walletSign(request, key),
        correlationId: OPTS.correlationId,
      },
      OPTS,
    );
    const result = await waitForTransaction(d.rpc, NETWORK, ref.txHash, WAIT, OPTS);
    expect(result.status, label).toBe('SUCCESS');
    d.hashes.push([label, ref.txHash]);
  }

  async function act(
    label: string,
    mandate: MandateRef | null,
    action: MandateAction,
    key: Keypair,
  ): Promise<string> {
    const request = await adapter.prepareMandateAction(
      {
        scope,
        mandate,
        action,
        signer: { kind: 'external', network: NETWORK, role: 'principal', address: at(key) },
      },
      OPTS,
    );
    await submit(label, request, key);
    return request.requestId;
  }

  function createAction(principal: Keypair): MandateAction {
    return {
      op: 'create',
      factory: at(d.factory),
      salt: `0x${randomBytes(32).toString('hex')}` as Bytes32,
      config: {
        principal: at(principal),
        asset: 'USDC',
        recipientMode: 'allowlist',
        agents: [at(keys.agent)],
        approvers: [at(keys.approver)],
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

  return { adapter, scope, store, act, submit, createAction, created };
}

describe.skipIf(!ENABLED)('Stellar mandate on a local network', () => {
  let d: LocalDeployment;

  beforeAll(async () => {
    const rpc = localRpc(RPC_URL);
    const network = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
    });
    const served = ((await network.json()) as { result?: { passphrase?: string } }).result;
    // Signed for testnet's passphrase, so it must be a network that uses it.
    expect(served?.passphrase).toBe(PASSPHRASE);
    d = await deploy(rpc);
  }, 300_000);

  it('creates, reads, pauses, resumes and funds a mandate for a G principal', async () => {
    const h = harness(d);
    const { adapter, scope } = h;
    const principal = d.keys.principal;
    const mandate = await h.created(
      await h.act('create', null, h.createAction(principal), principal),
    );

    const snapshot = await adapter.readMandate({ scope, mandate }, OPTS);
    expect(snapshot.config.principal.value).toBe(principal.publicKey());
    expect(snapshot.config.factory.value).toBe(d.factory);
    expect(snapshot.state.paused).toBe(false);

    await h.act('pause', mandate, { op: 'pause' }, principal);
    expect((await adapter.readMandate({ scope, mandate }, OPTS)).state.paused).toBe(true);
    await h.act('resume', mandate, { op: 'resume' }, principal);

    const funding = await adapter.prepareFunding(
      { scope, mandate, from: at(principal), amount: usdc(25n) },
      OPTS,
    );
    await h.submit('fund', funding, principal);
    const funded = await adapter.readMandate({ scope, mandate }, OPTS);
    expect(funded.state.balance.amount).toBe(usdc(25n).amount);
    expect(funded.state.free.amount).toBe(usdc(25n).amount);

    // The hashes are of a throwaway local network, kept as the record of the run.
    const lines = d.hashes.map(([label, txHash]) => `${label} ${txHash}`);
    process.stdout.write(
      [`local network, mandate ${mandate.address.value}`, ...lines, ''].join('\n'),
    );
  }, 600_000);
});
