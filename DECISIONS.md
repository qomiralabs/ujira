# Decisions

Smaller design decisions, each with what it was choosing between. Newest first.

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
