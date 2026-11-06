// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A closed mandate's funds going back to its principal on Stellar testnet, through
// the adapter's sweep from a channel account: refused while the principal cannot
// hold the asset, and paid in full once it can. Opt in with UJIRA_STELLAR_TESTNET=1;
// everywhere else it is skipped. Keys are the existing testnet identities in the
// stellar CLI's store outside the repository, held in memory and never printed.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import { Account, Asset, Keypair, Operation, TransactionBuilder, xdr } from '@stellar/stellar-base';
import type { Transaction } from '@stellar/stellar-base';
import { Keypair as SignerKeypair } from '@stellar/stellar-sdk/base';
import { tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { parseNetworksConfig } from '../config.js';
import { MandateRuleError, isChainAdapterError } from '../errors.js';
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
import { PASSPHRASES } from './tx.js';

const ENABLED = process.env['UJIRA_STELLAR_TESTNET'] === '1';
const NETWORK = 'stellar:testnet' as const;
const PASSPHRASE = PASSPHRASES[NETWORK];
const RPC_URL = process.env['UJIRA_TESTNET_RPC_URL'] ?? 'https://soroban-testnet.stellar.org';
const CONFIG_DIR = path.join(
  process.env['UJIRA_TESTNET_HOME'] ?? path.join(homedir(), '.config/ujira-testnet'),
  'stellar',
);
const CALL_TIMEOUT_MS = 30_000;

// The public record of the testnet deployment.
const FACTORY = 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7';
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = new Asset('USDC', USDC_ISSUER);
// One USDC, in the asset's seven decimal places.
const ONE_USDC = 10_000_000n;

function identity(name: string): Keypair {
  const secret = execFileSync(
    'stellar',
    ['--config-dir', CONFIG_DIR, 'keys', 'secret', `ujira-testnet-${name}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: CALL_TIMEOUT_MS },
  );
  return Keypair.fromSecret(secret.trim());
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const at = (key: Keypair | string): ChainAddress => ({
  network: NETWORK,
  value: typeof key === 'string' ? key : key.publicKey(),
});
const usdc = (units: bigint) => tokenAmount(units, 'USDC', 'stellar');

describe.skipIf(!ENABLED)('sweep.integration.test.ts', () => {
  it("a revoked mandate's funds go back to its principal once it can receive", async () => {
    const principal = identity('smoke-principal');
    const funder = identity('smoke-recipient');
    const agent = identity('smoke-agent');
    const approver = identity('smoke-approver');
    const sponsor = identity('threshold-sponsor');
    const channel = identity('threshold-sender');
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
      // The signer port takes the SDK's own key class.
      signer: keypairSigner(
        NETWORK,
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
    // Testnet RPC drops calls now and then. Reads are retried on a transport
    // failure only, never on an answer; sends are never retried here.
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
    const rpc: StellarRpc = {
      getEvents: (request, o) => again(() => base.getEvents(request, o)),
      getLatestLedger: (o) => again(() => base.getLatestLedger(o)),
      getLedgerEntries: (keys, o) => again(() => base.getLedgerEntries(keys, o)),
      simulateTransaction: (tx, o) => again(() => base.simulateTransaction(tx, o)),
      sendTransaction: (tx, o) => base.sendTransaction(tx, o),
      getTransaction: (txHash, o) => again(() => base.getTransaction(txHash, o)),
    };
    const requests = createMemorySigningRequestStore();
    const adapter = new StellarMandateAdapter({ network: NETWORK, rpc, ports, requests });
    const opts = { correlationId: `it-${randomUUID()}` };
    const record: string[] = [];

    async function landed(label: string, txHash: string): Promise<void> {
      for (let i = 0; i < 40; i += 1) {
        const tx = await rpc.getTransaction(txHash, opts);
        if (tx.status !== 'NOT_FOUND') {
          record.push(`${label}: ${txHash} ${tx.status}`);
          expect(tx.status, label).toBe('SUCCESS');
          return;
        }
        await sleep(2000);
      }
      throw new Error(`${label} did not land`);
    }

    async function sequenceOf(address: string): Promise<string> {
      const key = xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
      ).toXDR('base64');
      const [entry] = (await rpc.getLedgerEntries([key], opts)).entries;
      if (entry === undefined) throw new Error('the account does not exist');
      return xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64').account().seqNum().toString();
    }

    /** The account's USDC balance, or null with no trustline. */
    async function usdcOf(address: string): Promise<bigint | null> {
      const key = xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({
          accountId: Keypair.fromPublicKey(address).xdrAccountId(),
          asset: USDC.toTrustLineXDRObject(),
        }),
      ).toXDR('base64');
      const [entry] = (await rpc.getLedgerEntries([key], opts)).entries;
      if (entry === undefined) return null;
      const line = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64').trustLine();
      return BigInt(line.balance().toString());
    }

    /** A classic transaction from `key`'s own account, sent and waited for. */
    async function classic(label: string, key: Keypair, ops: xdr.Operation[]): Promise<void> {
      const builder = new TransactionBuilder(
        new Account(key.publicKey(), await sequenceOf(key.publicKey())),
        { fee: '1000', networkPassphrase: PASSPHRASE },
      );
      for (const op of ops) builder.addOperation(op);
      const tx: Transaction = builder.setTimeout(120).build();
      tx.sign(key);
      const sent = await rpc.sendTransaction(tx.toEnvelope().toXDR('base64'), opts);
      expect(sent.status, label).not.toBe('ERROR');
      await landed(label, sent.hash);
    }

    async function signAndSubmit(label: string, request: SigningRequest, key: Keypair) {
      if (request.kind !== 'stellar_transaction') throw new Error(`asked for ${request.kind}`);
      const tx = TransactionBuilder.fromXDR(request.xdr, PASSPHRASE) as Transaction;
      tx.sign(key);
      const ref = await adapter.submitSigned(
        {
          scope,
          requestId: request.requestId,
          signed: tx.toEnvelope().toXDR('base64'),
          correlationId: opts.correlationId,
        },
        opts,
      );
      await landed(label, ref.txHash);
      return request.requestId;
    }

    const act = async (label: string, mandate: MandateRef | null, action: MandateAction) =>
      signAndSubmit(
        label,
        await adapter.prepareMandateAction(
          {
            scope,
            mandate,
            action,
            signer: {
              kind: 'external',
              network: NETWORK,
              role: 'principal',
              address: at(principal),
            },
          },
          opts,
        ),
        principal,
      );

    // The funder holds a little testnet USDC, bought on the testnet exchange.
    if ((await usdcOf(funder.publicKey())) === null) {
      await classic('funder trustline', funder, [Operation.changeTrust({ asset: USDC })]);
    }
    if (((await usdcOf(funder.publicKey())) ?? 0n) < ONE_USDC) {
      await classic('funder buys USDC', funder, [
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: '20',
          destination: funder.publicKey(),
          destAsset: USDC,
          destAmount: '2',
        }),
      ]);
    }
    // The principal starts unable to hold USDC: what it has goes back, and the line goes.
    const held = await usdcOf(principal.publicKey());
    if (held !== null) {
      const ops = [Operation.changeTrust({ asset: USDC, limit: '0' })];
      if (held > 0n) {
        ops.unshift(
          Operation.payment({
            destination: funder.publicKey(),
            asset: USDC,
            amount: (Number(held) / 10_000_000).toFixed(7),
          }),
        );
      }
      await classic('principal drops its trustline', principal, ops);
    }

    const salt = `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}` as Bytes32;
    const createId = await act('create', null, {
      op: 'create',
      factory: at(FACTORY),
      salt,
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
          totalBudget: usdc(1000n * ONE_USDC),
          perPaymentCap: usdc(100n * ONE_USDC),
          perRecipientDailyCap: usdc(200n * ONE_USDC),
          approvalThreshold: usdc(10n * ONE_USDC),
          payoutTtlSeconds: 86_400,
          expiresAt: (clock() + 30n * 86_400n) as UnixSeconds,
        },
        attester: null,
        countryPolicyHash: `0x${'0'.repeat(64)}` as Bytes32,
        maxFeeBps: 100,
      },
    });
    const address = (await requests.load(scope, createId))?.request.mandate ?? '';
    expect(address).toMatch(/^C/);
    const mandate: MandateRef = { network: NETWORK, address: at(address), specVersion: 1 };

    await signAndSubmit(
      'fund',
      await adapter.prepareFunding(
        { scope, mandate, from: at(funder), amount: usdc(ONE_USDC) },
        opts,
      ),
      funder,
    );
    await act('revoke', mandate, { op: 'revoke' });
    const read = () => adapter.readMandate({ scope, mandate }, opts);
    expect((await read()).state).toMatchObject({ revoked: true });
    expect((await read()).state.balance.amount).toBe(ONE_USDC);

    // No trustline: the contract refuses the transfer, found in simulation, nothing sent.
    const refused = await adapter
      .sweepToPrincipal({ scope, mandate }, opts)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MandateRuleError);
    expect(refused).toMatchObject({ specName: 'TRANSFER_FAILED', landed: 'no' });
    record.push('sweep with no trustline: refused in simulation, TRANSFER_FAILED');

    // Fixed, the same call returns everything.
    await classic('principal adds its trustline', principal, [
      Operation.changeTrust({ asset: USDC }),
    ]);
    const swept = await adapter.sweepToPrincipal({ scope, mandate }, opts);
    await landed('sweep', swept.txHash);
    expect((await read()).state.balance.amount).toBe(0n);
    expect(await usdcOf(principal.publicKey())).toBe(ONE_USDC);

    // The hashes are public, and go on the issue as the record of the run.
    process.stdout.write(
      [`principal ${principal.publicKey()}, mandate ${address}`, ...record, ''].join('\n'),
    );
  }, 900_000);
});
