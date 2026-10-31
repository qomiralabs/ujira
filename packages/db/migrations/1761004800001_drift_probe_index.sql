-- expand
-- Throwaway: indexes a live table without CONCURRENTLY and without timeouts.

-- Up Migration
create index drift_probe_id on public.drift_probe (id);

-- Down Migration
drop index public.drift_probe_id;
