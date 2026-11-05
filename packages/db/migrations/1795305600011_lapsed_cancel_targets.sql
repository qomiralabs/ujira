-- expand
-- The sweep finds who has a lapsed attempt still to cancel through one narrow function, as
-- the other crons do, reading only tenant ids, the instance and its mandate.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

grant select (mandate_instance_id, dead_proof, lapse_cancelled_at)
  on ujira.payout_attempts to ujira_scheduler;
grant select (mandate_id) on ujira.mandate_instances to ujira_scheduler;

create function ujira.lapsed_cancel_targets(p_after uuid, p_limit integer)
  returns table (principal_id uuid, project_id uuid, mandate_instance_id uuid, mandate_id uuid)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'limit must be from 1 to 500';
  end if;
  return query
    select distinct a.principal_id, a.project_id, a.mandate_instance_id, i.mandate_id
      from ujira.payout_attempts as a
      join ujira.mandate_instances as i
        on i.principal_id = a.principal_id
       and i.project_id = a.project_id
       and i.id = a.mandate_instance_id
     where a.status = 'dead'
       and a.lapse_cancelled_at is null
       and a.dead_proof ->> 'kind' = 'payout_lapsed'
       and a.mandate_instance_id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
     order by 3
     limit p_limit;
end
$fn$;

grant execute on function ujira.lapsed_cancel_targets(uuid, integer) to ujira_app;

grant create on schema ujira to ujira_scheduler;
alter function ujira.lapsed_cancel_targets(uuid, integer) owner to ujira_scheduler;
revoke create on schema ujira from ujira_scheduler;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.lapsed_cancel_targets(uuid, integer);

revoke select (mandate_id) on ujira.mandate_instances from ujira_scheduler;
revoke select (mandate_instance_id, dead_proof, lapse_cancelled_at)
  on ujira.payout_attempts from ujira_scheduler;

reset role;
