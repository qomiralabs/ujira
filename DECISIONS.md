# Decisions

Smaller design decisions, each with what it was choosing between. Newest first.

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
