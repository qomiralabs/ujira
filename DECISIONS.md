# Decisions

Smaller design decisions, each with what it was choosing between. Newest first.

## Every project gets standard fee terms when it is created

**Problem.** No commitment is needed to start: a self-serve principal pays the standard rate for its actual volume, and the rate falls as volume rises. The fee builder refused any project with no terms row, and nothing wrote one, so no payout could be priced. Volume moved nothing either.

**Options.**

1. Treat a project with no row as being on the standard rate when a fee is worked out. There is nothing to write. But an attempt must name the terms a non-zero fee came from, and there would be no row to name, so "an attempt keeps the terms it was charged under" would stop being true for exactly the projects most likely to have no agreement.
2. Write the first row in each code path that creates a project. There is no trigger, but `create_principal`, `projects.create` and anything added later must each remember, and one that forgets refuses every payout of that project.
3. Write the first row in a trigger on `ujira.projects`. It holds for every path, including one nobody has written yet. The rule lives further from the code that reads it, and the trigger's function has to run where no tenant is set.

We chose option 3, and the existing projects are backfilled by the same function.

**How a month's rate is worked out.**

- The rate for a UTC month comes from the principal's executed volume in the month before it. A rate known when the month starts means a payout's price does not change as the month goes on.
- Volume is added up across all the principal's projects, because the promise is about the principal's volume, and splitting work into projects must not raise its price. Each project still has its own terms row.
- Only attempts at `settled` or `final` count. An attempt that settles and then dies stops counting.
- The floor of a band earns that band's rate, so exactly $100,000 is 70 basis points. The published table reads either way at the edge, and this one favours the principal.
- The rate can go back up: a quiet month after a busy one returns to the rate that quiet month earns.
- The rate moves by a new row valid from the month's start. Rows are never edited, so an attempt keeps the terms it was charged under.
- Terms in force that are not `standard` are left alone. Committed volume, negotiated and at cost terms are somebody's agreement.

**Why this shape.**

- Volume is one row per executed attempt, not a running counter. Recording never contends on a shared row, a rerun cannot count twice because the primary key refuses it, and an attempt that dies drops out by a join. The cost is a sum over a month's rows, which the job does once a month per project, on an index.
- The bands are in `ops.standard_fee_tiers`, changed only by a migration, because changing one is a price change.
- A rate is whole basis points from 0 to 100. The fee is still worked out by the existing `feeCap` at the lower of the rate and the mandate's `max_fee_bps`. The database did not check an attempt's rate against the mandate's cap, only its fee against its own rate, so a trigger now refuses a rate above the cap once the instance has reported one.
- Once a month's row is written it stands. An execution recorded after that moves nothing, because reopening it would mean a rate that changes after payouts were priced on it. So the job should run after the indexer has caught up with the month's end.
- The first row has no audit entry, because it is a default and nobody's decision, and the row is its own record. A rate that moves does have one.
- One token for now. The tiers table refuses a second, because adding up two tokens needs a decision about how.

**Evidence.** `packages/db/src/standard-fee-terms.test.ts` runs against real Postgres: each path that creates a project, every band edge to the raw unit, a month and a year rolling over, concurrent recording and concurrent jobs.

## Two logins run the migrations

**Problem.** The migrator login is `noinherit` and holds no server wide rights, on purpose. It could not run the migrations from zero: creating a schema and administering roles need more than it will ever hold, and a concurrent index build could not take the owner's rights at all. Measured on an empty database, connected as `ujira_migrator`: `permission denied for schema public` for the migrations table, `permission denied for database` for `create schema`, and `permission denied to alter role` in seven migrations. CI missed all of it because it migrated as a superuser.

**Options.**

1. Give the migrator inherited owner rights, and more. One login, and one URL in a deploy. It gives up least privilege for the login that runs in every deploy, and it still would not cover creating roles.
2. Move role administration out of migrations into a one time provisioning step, so the migrator can run every file. One login again, but it edits merged migrations, and every future role needs a step outside the migration history.
3. Two logins: a bootstrap login for the files that create a schema or administer roles, and the migrator for the rest, with the runner choosing per file.

**Decision.** Option 3. Merged migrations are not edited.

- A new file that needs the bootstrap login has `-- bootstrap` on its second line. Files merged before the marker existed are named in `MERGED_BOOTSTRAP_MIGRATIONS`, because editing them was ruled out.
- `check-migrations` refuses a file whose statements and marker disagree.
- The runner refuses to run a file under the wrong login, and checks with the server that each login is what it claims: the bootstrap login can create roles, and the migrator cannot.
- A run that names no login leaves a superuser free, which is what the tests and local containers are. Any other login is taken for the migrator, so naming nothing can never get a marked file run.
- The migrator still takes `ujira_owner` for a `-- no-transaction` migration, on the session, and resets it before the run is recorded. A login that already holds the owner's rights does not switch.

**Trade offs and risks.**

- A deploy holds a second, more powerful credential. It should be available only to the step that migrates, and only while it does.
- `ujira_migrator` has to be able to log in before the first file it runs, and migrations never set passwords. Provisioning sets one. A run that stops there resumes where it stopped.
- Each file opens its own connections, which costs little at this size.
- The bootstrap login holds a separate lock across the whole run, so a second run cannot slip between two files.

**Evidence.** `packages/db/src/migrate-as-migrator.test.ts` migrates from an empty database through both logins on every pull request.
