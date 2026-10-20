// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compile time checks on the exported types, run by typecheck.

import type { FiatCurrencyCode, TokenAsset } from '@ujira/core';
import type { NetworkId as AdapterNetworkId, RailId as AdapterRailId } from '@ujira/chain-adapter';
import { describe, expectTypeOf, it } from 'vitest';

import { availableBalance } from './index.js';
import type { RESERVES_BALANCE } from './index.js';
import type {
  AllowedBy,
  MandateRunway,
  OverviewKpis,
  OverviewStats,
  StatsSeries,
  MandateInstanceStatus,
  Money,
  NetworkId,
  PayoutDetail,
  PayoutLeg,
  PayoutMethod,
  PayoutStatus,
  RecipientReceipt,
  RouteResponse,
  TokenAmount,
} from './index.js';
import type { z } from 'zod';
import type { RailId } from './index.js';

describe('exported types', () => {
  it('PayoutDetail has legs, timeline, take and charged', () => {
    expectTypeOf<PayoutDetail['legs']>().toEqualTypeOf<PayoutLeg[]>();
    expectTypeOf<PayoutDetail['timeline'][0]['step']>().toEqualTypeOf<'requested'>();
    expectTypeOf<PayoutDetail['timeline'][4]['step']>().toEqualTypeOf<'delivered'>();
    expectTypeOf<NonNullable<PayoutDetail['charges']>['take']>().toEqualTypeOf<TokenAmount>();
    expectTypeOf<NonNullable<PayoutDetail['charges']>['charged']>().toEqualTypeOf<TokenAmount>();
    expectTypeOf<PayoutDetail['allowedBy']>().toEqualTypeOf<AllowedBy | null>();
    expectTypeOf<PayoutDetail['principalId']>().toEqualTypeOf<string>();
    expectTypeOf<PayoutDetail['projectId']>().toEqualTypeOf<string>();
    expectTypeOf<PayoutDetail>().not.toBeAny();
  });

  it('money amounts are strings, never numbers', () => {
    expectTypeOf<Money['amount']>().toEqualTypeOf<string>();
    expectTypeOf<Money['currency']>().toEqualTypeOf<FiatCurrencyCode>();
    expectTypeOf<TokenAmount['amount']>().toEqualTypeOf<string>();
    expectTypeOf<TokenAmount['asset']>().toEqualTypeOf<TokenAsset>();
  });

  it('closed lists match the adapter and are not widened to string', () => {
    expectTypeOf<NetworkId>().toEqualTypeOf<AdapterNetworkId>();
    expectTypeOf<z.infer<typeof RailId>>().toEqualTypeOf<AdapterRailId>();
    expectTypeOf<PayoutStatus>().not.toEqualTypeOf<string>();
    expectTypeOf<PayoutMethod>().toEqualTypeOf<
      'stellar_wallet' | 'bank' | 'mobile_money' | 'cash_pickup'
    >();
  });

  it('route responses are typed from the route table', () => {
    expectTypeOf<RouteResponse<'getPayout'>>().toEqualTypeOf<PayoutDetail>();
    expectTypeOf<RouteResponse<'listPayouts'>['nextCursor']>().toEqualTypeOf<string | null>();
  });

  it('the available balance is computed per instance status, not per string', () => {
    // A misspelled status must not compile, so the parameter is the enum.
    expectTypeOf(availableBalance).parameter(3).toEqualTypeOf<MandateInstanceStatus>();
    expectTypeOf(availableBalance).parameter(3).not.toEqualTypeOf<string>();
    // Every status is answered, so adding one is a compile error here.
    expectTypeOf<keyof typeof RESERVES_BALANCE>().toEqualTypeOf<MandateInstanceStatus>();
    expectTypeOf(availableBalance).returns.toEqualTypeOf<bigint>();
  });

  it('OverviewStats has kpis, mandates, approvalsWaiting, volume and corridors', () => {
    expectTypeOf<OverviewStats['current']['kpis']>().toEqualTypeOf<OverviewKpis>();
    expectTypeOf<OverviewStats['previous']>().toEqualTypeOf<OverviewStats['current'] | null>();
    expectTypeOf<NonNullable<OverviewStats['previous']>['kpis']>().toEqualTypeOf<OverviewKpis>();
    expectTypeOf<OverviewStats['mandates']>().toEqualTypeOf<MandateRunway[]>();
    expectTypeOf<OverviewStats['approvalsWaiting']>().toEqualTypeOf<number>();
    expectTypeOf<OverviewStats['volumeByCorridor']>().toEqualTypeOf<StatsSeries[]>();
    expectTypeOf<OverviewStats['volumeByStatus']>().toEqualTypeOf<StatsSeries[]>();
    expectTypeOf<OverviewStats['corridors'][number]['country']>().toEqualTypeOf<string>();
    // Money stays per currency and a runway can be absent.
    expectTypeOf<OverviewKpis['paid']>().toEqualTypeOf<Money[]>();
    expectTypeOf<MandateRunway['runwayDays']>().toEqualTypeOf<number | null>();
    expectTypeOf<OverviewStats['principalId']>().toEqualTypeOf<string>();
    expectTypeOf<RouteResponse<'getOverviewStats'>>().toEqualTypeOf<OverviewStats>();
    expectTypeOf<OverviewStats>().not.toBeAny();
  });

  it('a recipient local leg has no token or hash field', () => {
    type Local = Exclude<RecipientReceipt['legs'][number], { method: 'stellar_wallet' }>;
    expectTypeOf<Local>().not.toHaveProperty('txHash');
    expectTypeOf<Local['received']>().toEqualTypeOf<Money>();
  });
});
