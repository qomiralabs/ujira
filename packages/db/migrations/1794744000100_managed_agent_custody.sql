-- expand
-- A mandate's recipient mode, which its contract fixes at creation. The signer refuses a
-- key UJIRA holds while it is seated on a mandate that pays attested recipients only, so
-- the mode has to be known off chain. It is written once, by whoever records the instance,
-- from the config the contract was created with, and never changes after. While it is
-- unknown the signer refuses, because a guess could be the one mode that is not allowed.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.mandate_instances
  add column recipient_mode text,
  add constraint mandate_instances_recipient_mode
    check (recipient_mode in ('allowlist', 'attested', 'both')) not valid;

create function ujira.mandate_instance_recipient_mode_once() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.recipient_mode is not null and new.recipient_mode is distinct from old.recipient_mode then
    raise exception using
      errcode = 'UJ022',
      message = 'a mandate''s recipient mode is fixed once it is known';
  end if;
  return new;
end
$fn$;

create trigger mandate_instances_recipient_mode_once
  before update of recipient_mode on ujira.mandate_instances
  for each row execute function ujira.mandate_instance_recipient_mode_once();

grant update (recipient_mode) on ujira.mandate_instances to ujira_app;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

revoke update (recipient_mode) on ujira.mandate_instances from ujira_app;
drop trigger mandate_instances_recipient_mode_once on ujira.mandate_instances;
drop function ujira.mandate_instance_recipient_mode_once();
alter table ujira.mandate_instances
  drop constraint mandate_instances_recipient_mode,
  drop column recipient_mode;

reset role;
