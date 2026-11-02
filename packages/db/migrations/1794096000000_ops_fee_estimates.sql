-- expand
-- What each kind of submission has recently cost on each network, so a payout
-- can be checked against its take before it is sent. It aggregates over every
-- tenant's submissions and holds no tenant data, which is why it lives in ops.
-- The estimate never appears on a customer line.
--
-- The app reads it, since it prices payouts. Only ujira_ops writes it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ops.fee_estimates (
  network text not null
    constraint fee_estimates_network_format check (network ~ '^[a-z0-9-]+:[A-Za-z0-9-]+$'),
  op text not null
    constraint fee_estimates_op_known check (
      op in (
        'request',
        'request_batch',
        'execute',
        'execute_batch',
        'approve',
        'reject',
        'cancel',
        'cancel_batch'
      )
    ),
  -- Legs per payout item.
  leg_count integer not null
    constraint fee_estimates_leg_count_range check (leg_count between 1 and 4),
  -- Per item, in stroops.
  p95_resource_fee_stroops bigint not null
    constraint fee_estimates_resource_fee_not_negative check (p95_resource_fee_stroops >= 0),
  -- The rent part of the resource fee, so a receipt can show rent on its own line.
  p95_rent_stroops bigint not null
    constraint fee_estimates_rent_not_negative check (p95_rent_stroops >= 0),
  -- Charged per transaction, then shared per item.
  p95_inclusion_fee_stroops bigint not null
    constraint fee_estimates_inclusion_fee_not_negative check (p95_inclusion_fee_stroops >= 0),
  sample_count integer not null
    constraint fee_estimates_sample_count_positive check (sample_count > 0),
  window_start timestamptz not null,
  window_end timestamptz not null,
  computed_at timestamptz not null default now(),
  primary key (network, op, leg_count),
  constraint fee_estimates_rent_within_resource_fee
    check (p95_rent_stroops <= p95_resource_fee_stroops),
  constraint fee_estimates_window_ordered check (window_end > window_start)
);

grant select on ops.fee_estimates to ujira_app;
grant select, insert, update on ops.fee_estimates to ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop table ops.fee_estimates;
