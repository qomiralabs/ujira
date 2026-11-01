// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs the mandate operations against the factory deployed on Stellar
// testnet, with the throwaway testnet identities kept by the stellar CLI
// outside the repository. Opt in with UJIRA_STELLAR_TESTNET=1; everywhere
// else, CI included, it is skipped. Secret keys are read into memory through
// the CLI and never printed. With UJIRA_RECORD_FIXTURES=1 it also writes the
// raw RPC answers of one read to fixtures/, for the offline read tests.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  Keypair,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  xdr,
} from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { parseNetworksConfig } from '../config.js';
import { SubmissionRejectedError, isChainAdapterError } from '../errors.js';
import type { ExternalSignerRole } from '../signer.js';
import { tenantRefOf } from '../tenant-ref.js';
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
import { StellarMandateAdapter } from './mandate-adapter.js';
import { createMemorySigningRequestStore } from './requests.js';
import { createStellarRpc } from './rpc.js';
import type { StellarRpc } from './rpc.js';
import { keypairSigner, memoryStore, recordingSponsorship } from './test-ports.js';
import { PASSPHRASES } from './tx.js';

const ENABLED = process.env['UJIRA_STELLAR_TESTNET'] === '1';
const RECORD = process.env['UJIRA_RECORD_FIXTURES'] === '1';
const NETWORK = 'stellar:testnet' as const;
const RPC_URL = process.env['UJIRA_TESTNET_RPC_URL'] ?? 'https://soroban-testnet.stellar.org';
const CONFIG_DIR = path.join(
  process.env['UJIRA_TESTNET_HOME'] ?? path.join(homedir(), '.config/ujira-testnet'),
  'stellar',
);

// The public record of the testnet deployment.
const FACTORY = 'CAAVOGDGGM7JOLDS3CIQNPGSJOYFI54CJSAQQEFQKW7CES5UYIAZOYUQ';
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// The one key smart wallet built from packages/chain-adapter/fixtures/test-wallet
// and deployed on testnet, and the identity holding its owner key. Both need
// setting again after a testnet reset.
const WALLET =
  process.env['UJIRA_TESTNET_WALLET'] ?? 'CDHAK46P6AECDNJ3BQHUHQJVYFQU54KFUWB3NEV3CV5OWXKNQQ2T33BO';
const WALLET_OWNER = process.env['UJIRA_TESTNET_WALLET_OWNER'] ?? 'smoke-principal';

function identity(name: string): Keypair {
  const secret = execFileSync(
    'stellar',
    ['--config-dir', CONFIG_DIR, 'keys', 'secret', `ujira-testnet-${name}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return Keypair.fromSecret(secret.trim());
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Testnet RPC drops calls now and then. Reads are retried on a transport
// failure only, never on an answer; sends are never retried here.
function retrying(rpc: StellarRpc): StellarRpc {
  const again = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        const transient =
          isChainAdapterError(error) &&
          ['CHAIN_UNAVAILABLE', 'RPC_TIMEOUT', 'RPC_RATE_LIMITED'].includes(error.code);
        if (!transient || attempt >= 4) throw error;
        await sleep(attempt * 3000);
      }
    }
  };
  return {
    getLatestLedger: (opts) => again(() => rpc.getLatestLedger(opts)),
    getLedgerEntries: (keys, opts) => again(() => rpc.getLedgerEntries(keys, opts)),
    simulateTransaction: (tx, opts) => again(() => rpc.simulateTransaction(tx, opts)),
    sendTransaction: (tx, opts) => rpc.sendTransaction(tx, opts),
    getTransaction: (txHash, opts) => again(() => rpc.getTransaction(txHash, opts)),
  };
}

interface Recorded {
  readonly method: string;
  readonly params: unknown;
  readonly result: unknown;
}

// Records every answer of the read calls, as the JSON-RPC client returns them.
function recording(rpc: StellarRpc, log: Recorded[]): StellarRpc {
  const keep = async <T>(method: string, params: unknown, call: Promise<T>): Promise<T> => {
    const result = await call;
    const plain = JSON.stringify(result, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    log.push({ method, params, result: JSON.parse(plain) as unknown });
    return result;
  };
  return {
    getLatestLedger: (opts) => keep('getLatestLedger', {}, rpc.getLatestLedger(opts)),
    getLedgerEntries: async (keys, opts) => {
      const result = await rpc.getLedgerEntries(keys, opts);
      // Stored with `ledger` for the key, so a secret scanner does not take a
      // base64 ledger key for a credential.
      const entries = result.entries.map(({ key, ...rest }) => ({ ledger: key, ...rest }));
      await keep('getLedgerEntries', { keys }, Promise.resolve({ ...result, entries }));
      return result;
    },
    simulateTransaction: (tx, opts) =>
      keep('simulateTransaction', { transaction: tx }, rpc.simulateTransaction(tx, opts)),
    sendTransaction: (tx, opts) => rpc.sendTransaction(tx, opts),
    getTransaction: (txHash, opts) => rpc.getTransaction(txHash, opts),
  };
}

const at = (key: Keypair | string): ChainAddress => ({
  network: NETWORK,
  value: typeof key === 'string' ? key : key.publicKey(),
});

const usdc = (units: bigint) => tokenAmount(units * 10_000_000n, 'USDC', 'stellar');

// A wallet: signs exactly what it was handed. An account signs the
// transaction; the test smart wallet signs the entry's payload hash with its
// owner key and carries the bare 64 bytes as its signature.
async function walletSign(request: SigningRequest, key: Keypair): Promise<string> {
  const passphrase = PASSPHRASES[NETWORK];
  if (request.kind === 'stellar_transaction') {
    const tx = TransactionBuilder.fromXdr(request.xdr, passphrase);
    tx.sign(key);
    return tx.toXDR();
  }
  const entry = xdr.SorobanAuthorizationEntry.fromXdr(request.entryXdr, 'base64');
  if (request.signer.value.startsWith('G')) {
    return (await authorizeEntry(entry, key, request.expirationLedger, passphrase)).toXdr('base64');
  }
  const preimage = buildAuthorizationEntryPreimage(entry, request.expirationLedger, passphrase);
  const credentials = entry.credentials;
  if (credentials.type !== 'sorobanCredentialsAddress') throw new Error('not an address entry');
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: credentials.address.address,
        nonce: credentials.address.nonce,
        signatureExpirationLedger: credentials.address.signatureExpirationLedger,
        signature: xdr.ScVal.scvBytes(key.sign(hash(preimage.toXdr()))),
      }),
    ),
    rootInvocation: entry.rootInvocation,
  }).toXdr('base64');
}

function harness() {
  const sponsor = identity('deployer');
  const channel = identity('issuer');
  const clock = () => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
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
  const store = memoryStore(
    NETWORK,
    [{ address: channel.publicKey(), keyId: 'channel-1' }],
    clock,
  );
  const sponsorship = recordingSponsorship();
  const ports: AdapterPorts = {
    store,
    signer: keypairSigner(
      NETWORK,
      new Map([
        ['fee_sponsor', sponsor],
        ['executor:channel-1', channel],
      ]),
    ),
    sponsorship,
    alerts: { lowBalance: () => undefined, stuck: () => undefined, divergence: () => undefined },
    clock: { nowSeconds: clock },
    config: () => config,
  };
  const rpc = retrying(createStellarRpc({ network: NETWORK, url: RPC_URL, timeoutMs: 30_000 }));
  const requests = createMemorySigningRequestStore();
  const adapter = new StellarMandateAdapter({ network: NETWORK, rpc, ports, requests });
  const opts = { correlationId: `it-${randomUUID()}` };
  const scope: TenantScope = {
    principalId: randomUUID() as Uuid,
    projectId: randomUUID() as Uuid,
  };
  const hashes: [string, string][] = [];

  async function landed(label: string, txHash: string): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      const tx = await rpc.getTransaction(txHash, opts);
      if (tx.status !== 'NOT_FOUND') {
        expect(tx.status, label).toBe('SUCCESS');
        hashes.push([label, txHash]);
        return;
      }
      await sleep(2000);
    }
    throw new Error(`${label} did not land`);
  }

  async function act(
    label: string,
    mandate: MandateRef | null,
    action: MandateAction,
    key: Keypair,
    signer: ChainAddress = at(key),
    role: ExternalSignerRole = 'principal',
  ): Promise<string> {
    const request = await adapter.prepareMandateAction(
      {
        scope,
        mandate,
        action,
        signer: { kind: 'external', network: NETWORK, role, address: signer },
      },
      opts,
    );
    const ref = await adapter.submitSigned(
      {
        scope,
        requestId: request.requestId,
        signed: await walletSign(request, key),
        correlationId: opts.correlationId,
      },
      opts,
    );
    await landed(label, ref.txHash);
    return request.requestId;
  }

  function createAction(principal: ChainAddress, agent: Keypair, approver: Keypair): MandateAction {
    return {
      op: 'create',
      factory: at(FACTORY),
      salt: `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}` as Bytes32,
      config: {
        principal,
        asset: 'USDC',
        recipientMode: 'allowlist',
        tenantRef: tenantRefOf(scope),
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

  function report(title: string, mandate: MandateRef): void {
    const lines = hashes.map(([label, txHash]) => `${label} ${txHash}`);
    console.log(`${title}, mandate ${mandate.address.value}\n${lines.join('\n')}`);
  }

  return {
    adapter,
    rpc,
    requests,
    store,
    sponsorship,
    ports,
    opts,
    scope,
    hashes,
    act,
    createAction,
    created,
    report,
  };
}

describe.skipIf(!ENABLED)('Stellar mandate operations on testnet', () => {
  it('runs principal and recovery actions for a G principal through fee bumps', async () => {
    const principal = identity('nt-principal');
    const agent = identity('smoke-agent');
    const approver = identity('smoke-approver');
    const recovery = identity('smoke-recipient');
    const h = harness();
    const { adapter, scope, opts, act } = h;
    const create = h.createAction(at(principal), agent, approver);

    // A signer that is not the principal cannot authorize create.
    await expect(
      adapter.prepareMandateAction(
        {
          scope,
          mandate: null,
          action: create,
          signer: { kind: 'external', network: NETWORK, role: 'agent', address: at(agent) },
        },
        opts,
      ),
    ).rejects.toBeInstanceOf(SubmissionRejectedError);

    const mandate = await h.created(await act('create', null, create, principal));
    const log: Recorded[] = [];
    const reader = RECORD
      ? new StellarMandateAdapter({
          network: NETWORK,
          rpc: recording(h.rpc, log),
          ports: h.ports,
          requests: h.requests,
        })
      : adapter;
    const snapshot = await reader.readMandate({ scope, mandate }, opts);
    if (RECORD) {
      writeFileSync(
        path.join(import.meta.dirname, 'fixtures', 'testnet-read.json'),
        `${JSON.stringify({ scope, mandate: mandate.address.value, calls: log }, null, 2)}\n`,
      );
    }
    expect(snapshot.config.principal.value).toBe(principal.publicKey());
    expect(snapshot.config.tenantRef).toBe(tenantRefOf(scope));
    expect(snapshot.config.factory.value).toBe(FACTORY);
    expect(snapshot.state.paused).toBe(false);

    await act('pause', mandate, { op: 'pause' }, principal);
    // A rule refusal comes back under its spec name, before anything is signed.
    await expect(
      adapter.prepareMandateAction(
        {
          scope,
          mandate,
          action: { op: 'pause' },
          signer: { kind: 'external', network: NETWORK, role: 'principal', address: at(principal) },
        },
        opts,
      ),
    ).rejects.toMatchObject({ code: 'MANDATE_RULE', specName: 'ALREADY_PAUSED' });
    expect((await adapter.readMandate({ scope, mandate }, opts)).state.paused).toBe(true);
    await act('resume', mandate, { op: 'resume' }, principal);

    const role = { op: 'add_role', role: 'recovery', account: at(recovery) } as const;
    await act('add_role_recovery', mandate, role, principal);
    await act('remove_role_recovery', mandate, { ...role, op: 'remove_role' }, principal);
    await act('add_role_recovery_again', mandate, role, principal);
    await act('set_recovery_threshold', mandate, { op: 'set_recovery_threshold', n: 1 }, principal);
    await act('lower_fee_cap', mandate, { op: 'lower_fee_cap', maxFeeBps: 50 }, principal);
    const proposed = at(Keypair.random());
    await act('propose_principal', mandate, { op: 'propose_principal', proposed }, principal);
    await act('cancel_principal_proposal', mandate, { op: 'cancel_principal_proposal' }, principal);
    await act(
      'recovery_rotate_agent',
      mandate,
      { op: 'recovery_rotate_agent', old: at(agent), new: at(Keypair.random()) },
      recovery,
      at(recovery),
      'recovery',
    );
    await act('recovery_revoke', mandate, { op: 'recovery_revoke' }, recovery, at(recovery), 'recovery');

    const final = await adapter.readMandate({ scope, mandate }, opts);
    expect(final.state.revoked).toBe(true);
    expect(final.config.maxFeeBps).toBe(50);
    expect(final.config.recovery.map((a) => a.value)).toEqual([recovery.publicKey()]);
    expect(final.config.agents.map((a) => a.value)).not.toContain(agent.publicKey());
    // Every send was recorded first and is now broadcast, and every fee was reserved.
    expect([...h.store.submissions.values()].every((s) => s.state === 'broadcast')).toBe(true);
    expect(h.sponsorship.calls.filter((c) => c.kind === 'reserve')).toHaveLength(h.hashes.length);
    h.report('G principal', mandate);
  }, 900_000);

  it('runs actions for a C smart wallet principal through auth entries', async () => {
    const owner = identity(WALLET_OWNER);
    const agent = identity('smoke-agent');
    const approver = identity('smoke-approver');
    const h = harness();
    const { adapter, scope, opts, act } = h;
    const wallet = at(WALLET);

    const create = h.createAction(wallet, agent, approver);
    const mandate = await h.created(await act('create', null, create, owner, wallet));
    const snapshot = await adapter.readMandate({ scope, mandate }, opts);
    expect(snapshot.config.principal.value).toBe(WALLET);

    await act('pause', mandate, { op: 'pause' }, owner, wallet);
    await act('resume', mandate, { op: 'resume' }, owner, wallet);
    await act('lower_fee_cap', mandate, { op: 'lower_fee_cap', maxFeeBps: 25 }, owner, wallet);
    await act('revoke', mandate, { op: 'revoke' }, owner, wallet);

    const final = await adapter.readMandate({ scope, mandate }, opts);
    expect(final.state.revoked).toBe(true);
    expect(final.config.maxFeeBps).toBe(25);
    // Every channel lease was released, each with the lease id it was given.
    expect(h.store.releases).toHaveLength(h.hashes.length);
    h.report('C wallet principal', mandate);
  }, 900_000);
});
