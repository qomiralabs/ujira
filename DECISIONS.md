# Decisions

Smaller design decisions, each with what it was choosing between. Newest first.

## A migration run that waits for the lock tries again, rather than blocking

**Problem.** Several instances migrating at boot pass `lockMode: 'wait'`, and both the migration tool and the per-file runner waited by blocking in `pg_advisory_lock`. A concurrent index build waits for every transaction open while it runs, and a statement blocked on that lock is one. So the run holding the lock waited for the run waiting for it.

- With the tool's lock, Postgres saw the cycle and killed one with `40P01`.
- With the per-file runner, the lock is held on the bootstrap login's connection and the build runs on the migrator's. Postgres saw no cycle, and both waited forever.

This blocked running more than one instance.

**Options.**

1. Try for the lock, and sleep between tries with nothing open. Nothing the build waits for is left running, and a single run behaves as before.
2. Take the lock with a timeout and retry. Each wait is still a statement the build waits on, so this only shortens the deadlock.
3. Forbid concurrent index builds when more than one instance migrates. This gives up the only way to add an index to a live table without blocking writes.
4. Migrate from one deploy step, never at boot. Right for some deployments, and still a rule nothing enforces.

Chose 1, in both places. A run told to fail still fails at once, with the same message. A run told to wait tries every 250 ms, for as long as it takes, as the blocking wait did.

**Trade offs and risks.**

- A waiting run starts up to 250 ms after the lock frees, and a crowd of instances each try four times a second while they wait.
- No order among waiters, which the blocking wait had only by chance.
- A try that finds the lock taken opens and closes a connection each time. The tool takes its lock before it touches anything, so a try leaves nothing behind.

**Evidence.** `packages/db/src/migrate-wait.test.ts` runs real migrators at once against one Postgres, with a concurrent index build in the folder, through both entry points. Before this change the tool's path deadlocked and the per-file path hung.

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
