# Decisions

Smaller design decisions, each with what it was choosing between. Newest first.

## A revoked or expired mandate drops its compliance mark with no notice

**Problem.** A mandate revoked or expired while marked noncompliant is no longer listed among the principal's live instances, so no recheck ever looks at it again. Its mark never cleared, and its parked jobs stayed `blocked_by_policy` for good, behind a policy nobody could fix any more.

**Options.**

1. Clear the mark through `applyMark`, as a recheck would. It is one path, but it sends the principal a "compliant" notice for a mandate that did not become compliant, and it resumes jobs onto a mandate that cannot pay them.
2. Keep the mark as history, and mark the instance as retired. The record stays in one place, but every reader of marks has to learn to skip retired ones, and a forgotten reader would treat a dead mandate as still blocked.
3. Drop the mark with no notice, and close the parked jobs with the reason. The history stays in the notices, which are append only and still hold the "noncompliant" one.

We chose option 3.

- A closed job keeps its row, as `closed` with `mandate_revoked` or `mandate_expired`, so the payouts it belongs to can be reported with that reason.
- The close out takes the same lock as marking and parking. A job being parked as the revocation arrives is either parked first and closed by it, or finds no mark and is not parked, and its submission then meets the chain's own refusal.
- The principal is checked again without the retired mandate, because its budget no longer counts toward the line. Another mandate that only failed because of the total then clears in the normal way, with its notice and its resumed jobs.
- The retired instance is left out of that check even if the list of live instances has not caught up, so it can never be marked again.

**Evidence.** `packages/mandates/src/compliance.test.ts` (`a retired mandate`) and `packages/db/src/compliance-store.test.ts` (`closing out a retired mandate`), the second against real Postgres with parks racing the revocation.

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
