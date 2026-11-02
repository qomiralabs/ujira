// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Address, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import {
  InternalError,
  InvalidInputError,
  MandateUntrustedError,
  TenantMismatchError,
  UnsupportedError,
} from '../errors.js';
import { tenantRefOf, tenantTagOf } from '../tenant-ref.js';
import type { TenantScope, Uuid } from '../types.js';
import { addressXdr } from './address-xdr.js';
import { StellarMandateAdapter } from './mandate-adapter.js';
import { fieldsOf, struct, unit } from './scval.js';
import { OPTS, setup } from './test-adapter.js';
import { FIXTURE_FACTORY } from './test-rpc.js';
import { instanceKey } from './trust.js';

const OTHER_FACTORY = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** Rewrites one stored value of a contract's instance entry in the fake ledger. */
function rewriteInstance(
  rpc: ReturnType<typeof setup>['rpc'],
  contract: string,
  edit: (instance: xdr.ScContractInstance) => xdr.ScContractInstance,
): void {
  const key = instanceKey(contract).toXdr('base64');
  const entry = rpc.entries.get(key);
  if (entry === undefined) throw new Error('no such entry');
  const data = xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64');
  if (data.type !== 'contractData' || data.contractData.val.type !== 'scvContractInstance') {
    throw new Error('not an instance');
  }
  const cd = data.contractData;
  const val = cd.val;
  if (val.type !== 'scvContractInstance') throw new Error('not an instance');
  const next = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: cd.ext,
      contract: cd.contract,
      key: cd.key,
      durability: cd.durability,
      val: xdr.ScVal.scvContractInstance(edit(val.instance)),
    }),
  );
  rpc.entries.set(key, { ...entry, xdr: next.toXdr('base64') });
}

function withStored(name: string, value: xdr.ScVal) {
  return (instance: xdr.ScContractInstance): xdr.ScContractInstance =>
    new xdr.ScContractInstance({
      executable: instance.executable,
      storage: (instance.storage ?? []).map((entry) =>
        entry.key.toXdr('base64') === xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]).toXdr('base64')
          ? new xdr.ScMapEntry({ key: entry.key, val: value })
          : entry,
      ),
    });
}

// Building and parsing XDR is slow on a loaded machine, so each test gets
// more than the default five seconds.
describe('readMandate', { timeout: 30_000 }, () => {
  it('reads the recorded testnet mandate into the chain neutral snapshot', async () => {
    const t = setup();
    const snapshot = await t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS);
    expect(snapshot.trustedFactory).toBe(true);
    expect(snapshot.tenantRefMatches).toBe(true);
    expect(snapshot.asset).toBe('USDC');
    expect(snapshot.config.factory.value).toBe(FIXTURE_FACTORY);
    expect(snapshot.config.principal.value).toBe(
      'GDG25NP5BMPMQMARBHUYGRCNMB34DKZGTLQCR7MLNKZMIZ35DLR5UAOH',
    );
    expect(snapshot.config.agents.map((a) => a.value)).toEqual([
      'GAKNCMAXVSDXSSCG544P4E4CADBRGDHCCQX75U5KCTPHHOGDW6RPQQFG',
    ]);
    expect(snapshot.config.recipientMode).toBe('allowlist');
    expect(snapshot.config.tenantRef).toBe(tenantRefOf(t.scope));
    expect(snapshot.config.approvalsRequired).toBe(1);
    expect(snapshot.config.limits.totalBudget).toMatchObject({
      amount: 10_000_000_000n,
      asset: 'USDC',
    });
    expect(snapshot.config.limits.payoutTtlSeconds).toBe(86_400);
    expect(snapshot.config.attester).toBeNull();
    expect(snapshot.config.proposedPrincipal).toBeNull();
    expect(snapshot.config.maxFeeBps).toBe(100);
    expect(snapshot.state).toMatchObject({
      paused: false,
      revoked: false,
      expired: false,
      policyEpoch: 0,
    });
    expect(snapshot.state.balance.amount).toBe(0n);
    expect(snapshot.observedAt.finality).toBe('final');
    expect(snapshot.observedAt.time).toBe(t.rpc.latest.closeTime);
  });

  it('mandate from an unknown factory raises UntrustedMandateError', async () => {
    const t = setup({ trusted: [OTHER_FACTORY] });
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(MandateUntrustedError);
  });

  it('refuses a mandate running other code than the factory deploys', async () => {
    const t = setup();
    rewriteInstance(
      t.rpc,
      FIXTURE_FACTORY,
      withStored('MandateWasm', xdr.ScVal.scvBytes(Buffer.alloc(32, 1))),
    );
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(MandateUntrustedError);
  });

  it('refuses a mandate whose fee address differs from the factory', async () => {
    const t = setup();
    rewriteInstance(
      t.rpc,
      FIXTURE_FACTORY,
      withStored('FeeAddress', Address.fromString(OTHER_FACTORY).toScVal()),
    );
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(MandateUntrustedError);
  });

  it('refuses when the factory is gone or incomplete', async () => {
    const gone = setup();
    gone.rpc.entries.delete(instanceKey(FIXTURE_FACTORY).toXdr('base64'));
    await expect(
      gone.adapter.readMandate({ scope: gone.scope, mandate: gone.mandate }, OPTS),
    ).rejects.toBeInstanceOf(MandateUntrustedError);

    const partial = setup();
    rewriteInstance(
      partial.rpc,
      FIXTURE_FACTORY,
      (i) => new xdr.ScContractInstance({ executable: i.executable, storage: [] }),
    );
    await expect(
      partial.adapter.readMandate({ scope: partial.scope, mandate: partial.mandate }, OPTS),
    ).rejects.toBeInstanceOf(MandateUntrustedError);
  });

  it('refuses a contract that is no mandate', async () => {
    const t = setup();
    rewriteInstance(
      t.rpc,
      t.mandate.address.value,
      (i) => new xdr.ScContractInstance({ executable: i.executable, storage: [] }),
    );
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(MandateUntrustedError);

    const token = setup();
    rewriteInstance(
      token.rpc,
      token.mandate.address.value,
      (i) =>
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
          storage: i.storage,
        }),
    );
    await expect(
      token.adapter.readMandate({ scope: token.scope, mandate: token.mandate }, OPTS),
    ).rejects.toBeInstanceOf(MandateUntrustedError);
  });

  it('refuses another tenant before saying anything about trust', async () => {
    const t = setup({ trusted: [OTHER_FACTORY] });
    const other: TenantScope = {
      principalId: '00000000-0000-4000-8000-000000000001' as Uuid,
      projectId: t.scope.projectId,
    };
    await expect(
      t.adapter.readMandate({ scope: other, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('refuses a tag copied from another mandate of the same tenant', async () => {
    const t = setup();
    const copied = tenantTagOf(tenantRefOf(t.scope), addressXdr(OTHER_FACTORY));
    rewriteInstance(t.rpc, t.mandate.address.value, (instance) => {
      const fixed = (instance.storage ?? []).find(
        (e) => e.key.toXdr('base64') === unit('Fixed').toXdr('base64'),
      );
      if (fixed === undefined) throw new Error('no fixed entry');
      return withStored(
        'Fixed',
        struct({
          ...Object.fromEntries(fieldsOf(fixed.val)),
          tenant_tag: xdr.ScVal.scvBytes(Buffer.from(copied.slice(2), 'hex')),
        }),
      )(instance);
    });
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('refuses a mandate that still stores the reference rather than the tag', async () => {
    const t = setup();
    rewriteInstance(t.rpc, t.mandate.address.value, (instance) => {
      const fixed = (instance.storage ?? []).find(
        (e) => e.key.toXdr('base64') === unit('Fixed').toXdr('base64'),
      );
      if (fixed === undefined) throw new Error('no fixed entry');
      const kept = [...fieldsOf(fixed.val)].filter(([name]) => name !== 'tenant_tag');
      return withStored('Fixed', struct(Object.fromEntries(kept)))(instance);
    });
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(InternalError);
  });

  it('refuses an unknown address, another network and a malformed address', async () => {
    const t = setup();
    const missing = { ...t.mandate, address: { ...t.mandate.address, value: OTHER_FACTORY } };
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: missing }, OPTS),
    ).rejects.toBeInstanceOf(MandateUntrustedError);
    const pubnet = { ...t.mandate, network: 'stellar:pubnet' as const };
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: pubnet }, OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const garbage = { ...t.mandate, address: { ...t.mandate.address, value: 'Cnot-an-address' } };
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: garbage }, OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('refuses a mandate in an asset UJIRA does not settle in', async () => {
    const t = setup({ usdc: 'CAHEYQS6NA6U33P2OWSAPOVOBL626LOTATVUJ2W7HUCQX6EF34WSGC67' });
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('refuses a mandate of another spec version', async () => {
    const t = setup();
    t.rpc.onSimulate = (tx) => {
      const env = tx.toEnvelope();
      const fn = env.type === 'envelopeTypeTx' ? env.v1.tx.operations[0]?.body : undefined;
      return fn?.type === 'invokeHostFunction' &&
        fn.invokeHostFunctionOp.hostFunction.type === 'hostFunctionTypeInvokeContract' &&
        fn.invokeHostFunctionOp.hostFunction.invokeContract.functionName.toString() === 'version'
        ? t.rpc.success(tx, xdr.ScVal.scvU32(2), [])
        : undefined;
    };
    await expect(
      t.adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('refuses every call while the network is disabled', async () => {
    const t = setup();
    const config = t.ports.config();
    const disabled = { 'stellar:testnet': { ...config['stellar:testnet'], enabled: false } };
    const adapter = new StellarMandateAdapter({
      network: 'stellar:testnet',
      rpc: t.rpc,
      ports: { ...t.ports, config: () => disabled as typeof config },
      requests: t.requests,
    });
    await expect(
      adapter.readMandate({ scope: t.scope, mandate: t.mandate }, OPTS),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });
});
