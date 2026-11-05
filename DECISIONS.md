# Decisions

Smaller design decisions, each with what it was choosing between. Newest first.

## What the identity store reads where the tables are silent

**Problem.** The identity service's records carry facts the tables did not hold: whether a mandate instance is active, whether it takes attestations, which network a payout method is paid on, the project's identity settings, and the tenant of an identity row a provider's callback names by id alone.

**Options.**

1. Add a column for each fact and have the services that own them write it.
2. Derive what the existing rows already imply, and add columns only for what nothing implies.

**Decision.** Option 2.

- `mandate_instances.status` is new: `deploying` until something marks it `active`, so an instance nobody vouched for pays no one. The store reads deploying and a failed deploy as `pending`.
- The recipient mode comes from the attester key, which is set exactly when a mandate takes attestations. A mandate in `both` mode reads as `attested`. Eligibility treats the two the same, and the attester reads the mode from the chain itself.
- A method's network is the deployment's per chain, given to the store. A method records only its chain, because an address reads the same on every network of it.
- `projects.identity_settings` is new, an object or null for the defaults.
- `ujira.recipient_identity_scope(id)` answers whose an identity row is, for one exact id, owned by a role of its own.
- Anchor methods read as absent until methods record their anchor, so nothing is paid through an anchor on a guess.
- A suspended or erased recipient reads as inactive.

**Trade offs and risks.** Something has to move an instance to `active` before it can pay. Until the mandate flow does that, it is one call to `mandateInstances.setStatus`.

**Evidence.** The shared cases in `packages/identity/src/testing/contract.ts` run against memory and against Postgres (`packages/db/src/identity-store.test.ts`).

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
