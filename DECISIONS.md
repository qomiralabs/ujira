# Decisions

Smaller design decisions, each with what it was choosing between. Newest first.

## A mandate's recipient mode is recorded when its instance is

**Problem.** The signer must refuse a key UJIRA holds while it is seated on a mandate that pays attested recipients only. The seat comes from the chain's role events, but the mode was not stored off chain anywhere, so there was nothing to check a seat against.

**Options.**

1. The indexer writes the mode from the chain, out of the `mandate_created` event or a config read. It is the chain's own answer, but the factory event does not carry the mode, so every new instance needs an extra read, and an instance is unknown until that read lands.
2. Whoever records the instance writes the mode, from the config the contract was created with: the create flow, which built that config, or a claim, which reads it from the chain before it claims. It is known from the first moment the instance exists, with no read of its own.
3. Read the mode from the chain on every signature. It is always current, but every signature then waits on a node, and an outage of the node becomes an outage of signing.

We chose option 2.

- The contract fixes the mode at creation and nothing changes it, so the database holds it to the same rule. It is written once, a second write of another value is refused (`UJ022`), and the same value again changes nothing.
- While the mode is unknown the signer refuses a key seated there, as unavailable rather than denied. A guess could be the one mode that is not allowed, and an unknown mode is a gap to fill, not a breach.
- Seats are the mirror of the role events the indexer's intake store records, kept in the same transaction as the event. So a key the principal seats straight on the contract counts as soon as its event is read.
- A seat on another tenant's mandate never decides this tenant's key: seats are read under the key's own tenant.
- A refusal is logged at error level as `custody_refused`, because it means a key UJIRA holds is seated where it must never be.

**Evidence.** `packages/db/src/managed-agent-custody.test.ts` runs from the role event through the intake store to a refused signature, against real Postgres. `packages/signer/src/service/custody.test.ts` covers the service's guard, its slow and failed lookups, and the alert.

## A rotated operations guardian is still the guardian

**Problem.** Reconciliation knew only the operations guardian's current address. After a rotation every existing mandate still holds the old one, so it was reported as having no guardian, and an opt out the principal never made was recorded for good, which left every later instance of that mandate without the default protection.

**Options.**

1. Recognise only the current address, and rotate by asking every principal to update their mandates first. Nothing in UJIRA's hands decides when that is done.
2. Name the past addresses in the network configuration, and treat any of them as the operations guardian.

**Decision.** Option 2.

- `retiredOperationsGuardians` in a network section lists every address the guardian had before. The configuration refuses one that is the current address, listed twice, or a key UJIRA signs with.
- Reconciliation reports `present` when the current address is on chain, `outdated` when only a past one is, and `absent`, recording the opt out, only when none is.
- Removing a past address is the principal removing the guardian, unless the guardians left afterwards still include one of UJIRA's addresses, which is the principal moving to the current one.
- New mandates get only the current address.
- `outdated` tells the principal to move. UJIRA cannot change a mandate's roles, so moving is theirs: add the current address, then remove the old one.

**Trade offs and risks.** An address leaves the list only when no mandate holds it any more, or its removal would be read as an opt out again. Opt outs live only in memory so far, so there were none recorded to check before this ships; when they are stored, any recorded during a rotation window need checking against this list.

**Evidence.** `packages/mandates/src/guardian-removal.test.ts`, the cases under "after the operations guardian address is rotated".

## Which database logins exist, and which have a connection

**Problem.** The migrations create seven login roles, and `packages/db` had a connection for only some of them. The indexer wrote tenant rows through the worker's pool, which in tests logged in as `ujira_indexer`, while the worker's own login holds no rights on tenant tables. A deploy could not tell which logins to provision, or which URL each process needs.

**Options.**

1. Keep one worker pool and log it in as the indexer where the indexer runs. One URL fewer, but the worker's jobs would then hold the indexer's write rights on tenant tables, and the two could not be separated again without a deploy.
2. A connection per login the code uses today, and a login with no connection yet only where a role needs one. Each process holds only the rights its work needs.
3. A connection for all seven now. Pools nothing uses would spend the connection budget, and their URLs would be secrets held for no reason.

**Decision.** Option 2. Every environment, local, staging and production, has the same seven logins, each with its own password from the secret manager, and none is shared between services.

| Login             | Used by                                                               | Connection in `packages/db` |
| ----------------- | --------------------------------------------------------------------- | --------------------------- |
| `ujira_app`       | The API, for tenant reads and writes                                  | `UJIRA_DB_APP_URL`          |
| `ujira_reader`    | Reads across a principal's projects                                   | `UJIRA_DB_READER_URL`       |
| `ujira_worker`    | The job runner, which listens and holds no tenant rights              | `UJIRA_DB_WORKER_URL`       |
| `ujira_indexer`   | The chain event indexer, which writes the on chain mirror per tenant  | `UJIRA_DB_INDEXER_URL`      |
| `ujira_migrator`  | The migrations, beside the bootstrap login                            | `UJIRA_DB_MIGRATION_URL`    |
| `ujira_ops`       | Operations jobs that hold no customer data, such as the fee estimates | None yet                    |
| `ujira_retention` | The retention job                                                     | None yet                    |
| `ujira_auth`      | Authentication                                                        | None yet                    |

A login with no connection gets one when the first code that runs as it arrives, in that change, counted in the same budget.

**Trade offs and risks.**

- The indexer adds two connections to the default budget, 19 of the 30 reserved.
- Until the worker roles land, the test databases have no `ujira_worker`, so the test worker pool logs in as `ujira_ops`, which also holds no tenant rights. Nothing in the tests writes tenant rows through it.
- The indexer may use the transaction pooler because it listens for nothing. If it ever needs LISTEN, it joins the session only roles.

**Evidence.** `packages/db/src/indexer-connection.test.ts` connects through the new pool and finds `ujira_indexer`, and the worker pool is not that login. `config.test.ts` counts the pool in the budget, and `env-template.test.ts` checks `.env.example` documents both new variables.

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
