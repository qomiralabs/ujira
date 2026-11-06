-- expand
-- Validates the recipient mode check the previous migration added as not valid, in its own
-- step, so adding it never held a lock while the table was scanned.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.mandate_instances validate constraint mandate_instances_recipient_mode;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.mandate_instances
  drop constraint mandate_instances_recipient_mode,
  add constraint mandate_instances_recipient_mode
    check (recipient_mode in ('allowlist', 'attested', 'both')) not valid;

reset role;
