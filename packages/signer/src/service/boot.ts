// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What each signer process does between starting and taking work: read its
// environment, build its backend, prove its keys are the right ones, and only
// then open a port. A failed check leaves nothing listening, so a load balancer
// or a caller never reaches a service that should not exist.
//
// The role is fixed by which entry point ran rather than read from the
// environment, so a configuration mistake cannot turn the attester into
// something that signs transactions.
//
// The stores behind the policies do not all exist yet. The in-memory ones are
// empty and answer null, so until the real ones are wired the process runs and
// refuses everything that needs a record.

import {
  ChainAdapterError,
  InvalidInputError,
  NETWORK_IDS,
  parseNetworksConfig,
} from '@ujira/chain-adapter';
import type {
  CallOptions,
  NetworkId,
  NetworksConfig,
  SignerProvider,
  SignerRef,
} from '@ujira/chain-adapter';
import { z } from 'zod';

import { verifyAttesterStartup } from '../attester-startup.js';
import {
  AWS_KMS_PROVIDER,
  AwsKmsSigner,
  awsKmsClient,
  configKeyResolver,
  readKmsEnvironment,
} from '../aws-kms/index.js';
import type { ExtraKmsKey, KmsKeyResolver, KmsSend } from '../aws-kms/index.js';
import { LocalSigner } from '../local-signer.js';
import { LOCAL_PROVIDER, verifySignerStartup } from '../startup.js';

import { agentPolicy } from './agent-policy.js';
import { attestPolicy } from './attest-policy.js';
import type { ServiceCaller } from './auth.js';
import { chainPolicy } from './chain-policy.js';
import type { ChainNetworkPolicy } from './chain-policy.js';
import { jsonSignerLogger, writeLog } from './log.js';
import type { SignerLogFields, SignerLogger } from './log.js';
import {
  memoryAttestationLog,
  memoryManagedSignerStore,
  memoryMandateIndex,
  memoryRateLimiter,
  memorySponsorshipLedger,
} from './memory.js';
import type { ServicePolicy } from './policy.js';
import type {
  AttestationLog,
  ManagedSignerStore,
  MandateIndex,
  PrincipalRateLimiter,
  SponsorshipLedger,
} from './ports.js';
import { startSignerService } from './serve.js';
import type { RunningService } from './serve.js';
import { createSignerService } from './service.js';

export type SignerRole = 'chain' | 'agent' | 'attester';

type Environment = Readonly<Record<string, string | undefined>>;

const BACKEND_TIMEOUT_MS = 10_000;
const KMS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Long enough to read a few public keys on a cold start, short enough that a
// key manager that never answers stops the deploy instead of hanging it.
const STARTUP_TIMEOUT_MS = 60_000;
const AGENT_REQUESTS_PER_MINUTE = 60;

/** Who may call each service. A token for anyone else is refused. */
const CALLERS: Readonly<Record<SignerRole, readonly string[]>> = Object.freeze({
  chain: ['payouts', 'adapter'],
  agent: ['payouts'],
  attester: ['identity'],
});

const SETTLEMENT_ASSET_CODE = 'USDC';

const environmentSchema = z.object({
  UJIRA_SIGNER_BACKEND: z.enum([LOCAL_PROVIDER, AWS_KMS_PROVIDER]),
  UJIRA_NETWORKS_CONFIG: z.string().min(1),
  // Loopback unless a deployment says otherwise, so a process started by hand
  // is never reachable from outside the machine.
  UJIRA_SIGNER_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.:-]{1,253}$/)
    .default('127.0.0.1'),
  PORT: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.int().max(65_535)),
});

export interface SignerStores {
  readonly mandates: MandateIndex;
  readonly sponsorships: SponsorshipLedger;
  readonly signers: ManagedSignerStore;
  readonly rateLimiter: PrincipalRateLimiter;
  readonly attestations: AttestationLog;
}

/** Empty, so each answers null and every request that needs a record is refused. */
function emptyStores(): SignerStores {
  return {
    mandates: memoryMandateIndex(),
    sponsorships: memorySponsorshipLedger(),
    signers: memoryManagedSignerStore(),
    rateLimiter: memoryRateLimiter({ limit: AGENT_REQUESTS_PER_MINUTE, windowSeconds: 60n }),
    attestations: memoryAttestationLog(),
  };
}

export interface BootOptions {
  readonly env: Environment;
  readonly logger: SignerLogger;
  /** The real stores; empty ones that refuse everything when left out. */
  readonly stores?: SignerStores;
  /** For tests; the KMS SDK's own client when left out. */
  readonly kmsSend?: KmsSend;
  /** For tests; startSignerService when left out. */
  readonly listen?: typeof startSignerService;
}

function refused(issue: string): InvalidInputError {
  return new InvalidInputError({ issues: [issue] });
}

function readNetworks(text: string): NetworksConfig {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // The parser's message quotes the text it choked on.
    throw refused('UJIRA_NETWORKS_CONFIG (invalid_json)');
  }
  return parseNetworksConfig(document);
}

function callersOf(role: SignerRole, env: Environment): readonly ServiceCaller[] {
  return CALLERS[role].map((name) => {
    const variable = `UJIRA_SIGNER_TOKEN_${name.toUpperCase()}`;
    const token = env[variable];
    if (token === undefined) throw refused(`${variable} (missing)`);
    return { name, token };
  });
}

function policyFor(
  role: SignerRole,
  config: NetworksConfig,
  networks: readonly NetworkId[],
  stores: SignerStores,
): ServicePolicy {
  switch (role) {
    case 'chain': {
      const policies: Partial<Record<NetworkId, ChainNetworkPolicy>> = {};
      for (const network of networks) {
        const section = config[network];
        if (section === undefined) continue;
        policies[network] = {
          executorMaxFeeStroops: section.feeSponsor.maxFeePerTxStroops,
          sponsorMaxFeeStroops: section.feeSponsor.maxFeePerTxStroops,
          payoutAsset: { code: SETTLEMENT_ASSET_CODE, issuer: section.assets.USDC.issuer },
          // The configuration names each anchor's key but not its server
          // account or domains, so every challenge is refused until it does.
          sep10: {},
        };
      }
      return chainPolicy({
        networks: policies,
        mandates: stores.mandates,
        sponsorships: stores.sponsorships,
      });
    }
    case 'agent':
      return agentPolicy({
        signers: stores.signers,
        mandates: stores.mandates,
        rateLimiter: stores.rateLimiter,
      });
    case 'attester':
      return attestPolicy({ mandates: stores.mandates, log: stores.attestations });
  }
}

function kmsKeyResolver(
  role: SignerRole,
  env: Environment,
  config: NetworksConfig,
  networks: readonly NetworkId[],
  stores: SignerStores,
): KmsKeyResolver {
  const none = parseNetworksConfig({});
  switch (role) {
    case 'chain':
      return configKeyResolver(config);
    case 'agent':
      // A key per tenant and agent, so they live in a table and not in config.
      // Only that tenant's own row can name one.
      return configKeyResolver(none, [], async (ref: SignerRef, opts: CallOptions) => {
        if (ref.kind !== 'managed_agent') return null;
        const signer = await stores.signers.active(ref.network, ref.scope, ref.agentId, opts);
        return signer?.keyRef ?? null;
      });
    case 'attester': {
      const keyId = env['UJIRA_ATTESTER_KMS_KEY_ID'];
      if (keyId === undefined || keyId === '') {
        throw refused('UJIRA_ATTESTER_KMS_KEY_ID (missing)');
      }
      const keys = networks.map((network): ExtraKmsKey => ({
        ref: { kind: 'attester', network },
        keyId,
      }));
      return configKeyResolver(none, keys);
    }
  }
}

function backendFor(
  backend: typeof LOCAL_PROVIDER | typeof AWS_KMS_PROVIDER,
  keyFor: () => KmsKeyResolver,
  options: BootOptions,
): SignerProvider {
  if (backend === LOCAL_PROVIDER) return LocalSigner.fromEnv(options.env);
  const environment = readKmsEnvironment(options.env);
  const client = awsKmsClient({
    environment,
    ...(options.kmsSend === undefined ? {} : { send: options.kmsSend }),
  });
  return new AwsKmsSigner({ client, keyFor: keyFor(), timeoutMs: KMS_TIMEOUT_MS });
}

/**
 * Starts one signer service, or throws with nothing listening. The checks run
 * before the port opens, so a service with the wrong key never takes a request.
 */
export async function bootSignerService(
  role: SignerRole,
  options: BootOptions,
): Promise<RunningService> {
  const { env, logger } = options;
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    // Paths and codes only: zod's messages can quote what was received.
    throw new InvalidInputError({
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')} (${issue.code})`),
    });
  }
  const settings = parsed.data;
  const config = readNetworks(settings.UJIRA_NETWORKS_CONFIG);
  const networks = NETWORK_IDS.filter((network) => config[network] !== undefined);
  if (networks.length === 0) throw refused('UJIRA_NETWORKS_CONFIG (no_networks)');
  const stores = options.stores ?? emptyStores();
  const callers = callersOf(role, env);
  const provider = backendFor(
    settings.UJIRA_SIGNER_BACKEND,
    () => kmsKeyResolver(role, env, config, networks, stores),
    options,
  );
  const app = createSignerService({
    provider,
    policy: policyFor(role, config, networks, stores),
    callers,
    logger,
    backendTimeoutMs: BACKEND_TIMEOUT_MS,
  });

  const correlationId = `startup-${role}`;
  const opts: CallOptions = { correlationId, signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) };
  const nodeEnv = env['NODE_ENV'];
  // Only the chain service holds the keys configuration pins. The others would
  // be refused them by the key manager, so they check against no pins, which
  // still runs the production rule on the way.
  await verifySignerStartup({
    signer: provider,
    config: role === 'chain' ? config : parseNetworksConfig({}),
    nodeEnv,
    opts,
  });
  if (role === 'attester') {
    await verifyAttesterStartup({ signer: provider, networks, nodeEnv, opts });
  }

  const listen = options.listen ?? startSignerService;
  const running = await listen(app, {
    port: settings.PORT,
    hostname: settings.UJIRA_SIGNER_HOST,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  writeLog(logger, 'info', 'listening', correlationId, new Date(), {});
  return running;
}

/** What a startup failure may say: codes and the names of variables, never a value. */
function faultOf(error: unknown): SignerLogFields {
  if (error instanceof InvalidInputError) {
    return { errorCode: error.code, issues: error.issues };
  }
  if (error instanceof ChainAdapterError) {
    return error.network === null
      ? { errorCode: error.code }
      : { errorCode: error.code, network: error.network };
  }
  // A system error such as EADDRINUSE tells an operator what to fix. Anything
  // else could carry text from anywhere, so only its absence is reported.
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return { errorCode: typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'INTERNAL' };
}

export interface RunOptions {
  readonly env?: Environment;
  readonly stores?: SignerStores;
  readonly kmsSend?: KmsSend;
  readonly listen?: typeof startSignerService;
  readonly writeLine?: (line: string) => void;
  readonly exit?: (code: number) => void;
  /** Calls `stop` when the platform asks the process to end. */
  readonly onStopRequest?: (stop: () => void) => void;
}

/** The body of an entry point: runs the service until asked to stop, or exits 1. */
export async function runSignerService(role: SignerRole, options: RunOptions = {}): Promise<void> {
  const logger = jsonSignerLogger(
    options.writeLine ??
      ((line) => {
        process.stdout.write(`${line}\n`);
      }),
  );
  const exit =
    options.exit ??
    ((code: number) => {
      process.exit(code);
    });
  let running: RunningService;
  try {
    running = await bootSignerService(role, {
      env: options.env ?? process.env,
      logger,
      ...(options.stores === undefined ? {} : { stores: options.stores }),
      ...(options.kmsSend === undefined ? {} : { kmsSend: options.kmsSend }),
      ...(options.listen === undefined ? {} : { listen: options.listen }),
    });
  } catch (error) {
    writeLog(logger, 'error', 'startup_refused', `startup-${role}`, new Date(), faultOf(error));
    exit(1);
    return;
  }
  const stop = (): void => {
    running.close().then(
      () => {
        exit(0);
      },
      () => {
        exit(1);
      },
    );
  };
  const onStopRequest =
    options.onStopRequest ??
    ((handler: () => void) => {
      process.once('SIGTERM', handler);
      process.once('SIGINT', handler);
    });
  onStopRequest(stop);
}
