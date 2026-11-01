-- Fixture seed for rehearsal.test.ts.
insert into public.things (id)
select g from generate_series(1, current_setting('ujira.synthetic_rows')::bigint) as g;
