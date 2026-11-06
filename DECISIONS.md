# Decisions

Smaller design decisions, each with what it was choosing between. Newest first.

## The executor cancels lapsed payouts

**Problem.** A lapsed payout can never execute, but the mandate counts its funds as committed until someone cancels it. So a mandate with nothing spare cannot pay the retry after a lapse. The operator also has to cancel lapsed payouts before their records archive, and nothing did. The agent key never cancels, which a person decided, and `AGENT_FUNCTIONS` stays as it is. Something UJIRA runs has to send this call.

**Options.**

1. Leave it to the principal's wallet. No key changes, but the funds stay stuck until a person acts, and the retry with them.
2. A key of its own, whose only job is this. Clean to reason about, and one more key to provision, fund and rotate, for a call anyone may make.
3. Let the executor send it. It already has the role on these mandates and already pays fees.

Chose 3. **This gives no power any address lacks:** once a payout has lapsed, the contract takes a cancel from anyone, and before that it refuses this caller.

- The one way that would not hold is an executor address that is also the mandate's principal or an agent, since the contract takes a live cancel from either. The policy refuses those, and refuses when the index cannot say who holds those roles.
- `cancel` and `cancel_batch` sit on a list of their own, so `EXECUTOR_FUNCTIONS` still says what an executor exists to do.
- The adapter checks the payout has lapsed before it sends, so it spends no fee on one the contract would refuse.
- The retry goes first after the lapse proof when funds allow. When they do not, it is held, and the sweep's cancel frees the funds and wakes the release job.
- A sweep every ten minutes finds what is left through one narrow function and files a job on each mandate's queue, so it does not race that mandate's payouts. Each attempt records when it was cleared.

**Trade offs and risks.**

- **This widens a signer policy,** so it is on the security review list.
- The rule against a shared address relies on the index being right about who holds those roles. The production index is not built yet, and has to supply them or every cancel is refused.
- UJIRA pays the fee on these cancels, per lapsed payout.
- Deadlines are not timed from a record's `liveUntilLedgerSeq`. Every sweep cancels everything lapsed, so nothing waits long enough to need one. A missed window costs only a restore fee, and an archived record still counts as present.
- The adapter sends one cancel per payout, not `cancel_batch`. That costs more fees if many lapse at once, and the policy allows the batch for when that matters.

**Evidence.** `packages/signer/src/service/chain-policy.cancel.test.ts`, `packages/chain-adapter/src/testing/cancel-lapsed.test.ts` against the fake engine, which follows the contract's rule, and `packages/payouts/src/engine/cancel-lapsed.test.ts`, which runs the nothing spare case end to end.

## A split whose transfer failed waits to lapse rather than being cancelled

**Problem.** An execute is atomic, so one leg whose transfer fails blocks the whole payout, and the chain holds the request with funds committed to it. The next attempt, on the recipient's main method, must wait until this one can never land. A cancel would prove that at once. The mandate lets an agent cancel its own payout, but the agent keys UJIRA holds may only ask for a payout: `AGENT_FUNCTIONS` in the signer's agent policy holds `request_payout` and `request_payouts`, and anything else stays with the principal's own wallet.

**Options.**

1. Let the attempt lapse. At its on-chain expiry the adapter gives a `payout_lapsed` proof, which frees a new attempt on the main method. It needs no key and no signature.
2. Ask the principal's own wallet to cancel. No key changes, but the payout waits on a person, and something has to tell them.
3. Add `cancel` to `AGENT_FUNCTIONS`. The fastest recovery, and it widens what a key UJIRA holds may sign. A stolen agent key could then cancel that agent's open payouts, although no funds would move. Non-custody rules this out without a person deciding it.

Chose 1. Option 2 could be added later as a way for a principal to speed things up.

- While it waits the job does not execute the attempt again, even if the transfer would now succeed. It only asks for the proof, about every 15 minutes, so the outcome does not depend on when a job happens to run.
- A batch leaves such an item alone in the same way.
- A failed transfer on a single leg is unchanged: it has no other method to go to, so it takes the bounded retries to a person.

**Trade offs and risks.**

- **The recipient waits up to the mandate's `payout_ttl_seconds`, and the funds stay committed until then, and until the sweep cancels the attempt.** Attestations can shorten that, and the test mandates use a day. A recipient on a failed split is not paid in the meantime, even if the cause clears. Nothing alerts on this wait: `refusal_code` shows `TRANSFER_FAILED` on a payout that is still live.
- Each waiting payout costs one chain read per look.
- Splits ship at P1, so nothing reaches this path until then.

**Evidence.** `packages/payouts/src/engine/fallback.test.ts`: `retries only after a payout_lapsed proof, and never before`, `a clean rerun of every step still gives one attempt on the main method`, and `a job killed at every step still gives one attempt on the main method`.

## A new attempt rechecks the balance under the instance's row lock

**Problem.** The router works out a mandate's free balance, and a job then writes an attempt against it. A job's running balance is only its own, so two jobs can promise the same funds. The queue runs one release per principal and network at a time, but that does not cover two runs after a lost job lock, which a test showed releasing 3 payouts against funds for 2. It also does not cover a new payout and a release, which are on different queues, so they can race with no lost lock at all. The mandate refuses to spend what it does not hold, so this cannot pay twice, but a money rule should not depend on the queue.

**Options.**

1. Keep relying on the queue. Nothing to build, and the rule breaks in exactly the cases above.
2. A lock in the release job only. It closes the case that was seen, and leaves a new payout free to take funds a release has just promised.
3. Lock the mandate instance's row in every transaction that creates an attempt, then recheck there: chain free balance less what is routed and not yet requested must cover this attempt.
4. Serialize on a Postgres advisory lock, which needs no new right. It has no row to point at, and its key space is shared with anything else that takes one.

Chose 3. The balance belongs to one instance, so that row and no wider one is what is locked. A route that comes up short rolls back: a release leaves the payout held, and a new payout's job retries, routes again and is held.

- The app login had no update right on `mandate_instances`, and a row lock takes one. So it gets update on one new column, `balance_checked_at`, and nothing else on that table. The lock is an update of that column, which does not block the foreign key checks of other attempts.
- The sum of what is promised is read first and the chain second. A request landing between the two is counted twice, which only holds a payout back until the next run. The other order would miss it.

**Trade offs and risks.**

- A chain read happens inside a transaction, holding a pooled connection and the row lock, bounded at 5 seconds. Everything else that reaches a network stays outside. Reading the chain before taking the lock avoids that, but then a request landing in between is counted not at all, and closing that gap needs timestamps on attempts compared with the chain read, which is harder to get right than the cost is worth at one queue per mandate.
- New attempts on one instance are serial, at the speed of that read. Each mandate's payouts already run one at a time on its queue, so this adds little there; it does mean a release and a mandate's payout job wait for each other.
- A waiter can hit the transaction's lock timeout under contention. That fails the job, and the queue retries it.
- A lagging RPC node can still report too much free balance. The node check in the adapter bounds the lag, and the mandate stays the final word on what it spends.
- Under a lost job lock, which two payouts are released depends on timing, so oldest first holds only when the queue runs releases one at a time.

**Evidence.** `packages/payouts/src/engine/release.test.ts > two truly concurrent releases against funds for 2 release exactly 2 and leave the third held`, and `> a new payout routed while a release runs cannot take the same funds`, which forces the race with a barrier.

## Only the chain makes a mandate instance active

**Problem.** Eligibility refuses to pay under an instance that is not active, and nothing moved one there. Whatever does has to be something an API call cannot fake, because an active instance is one UJIRA will attest payouts under.

**Options.**

1. The mandate creation flow marks the instance active when its deploy transaction lands. It runs on the API's login and believes its own submission.
2. The event intake does it, when it reads a trusted factory's `mandate_created` for the contract under the claiming tenant's recomputed tag, and follows the mandate's own `paused`, `resumed` and `revoked` after that.

**Decision.** Option 2. Intake is already the one writer of the mandate registry, with the checks that make a contract a mandate.

- Each move starts only from set states (`INSTANCE_MOVES` in `packages/chain-adapter`), so a replay, or an event read out of turn, changes nothing, and nothing brings a revoked instance back.
- Only a newly booked event moves an instance, so reading a range again cannot undo a later move.
- A contract claimed after its creation was read becomes active on its next event.
- Only the indexer's login may change `mandate_instances.status`, and only under the instance's tenant. No login the API holds may, which the database enforces.

**Trade offs and risks.**

- A mandate claimed after its creation, with no event since, stays `deploying` until it has one.
- Expiry has no event, so it is not mirrored. The attester reads it from the chain on every attestation, which refuses an expired mandate.
- A failed deploy is not marked `deploy_failed` yet. A failed deploy has no creation event, so it stays `deploying`, which pays no one either.

**Evidence.** `packages/chain-adapter/src/intake.test.ts`, "the instance that claims a mandate", and `packages/db/src/instance-lifecycle.test.ts` against Postgres.

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

**Trade offs and risks.** Something has to move an instance to `active` before it can pay, and no login the API holds may: that is the chain's to say, through the indexer (#609).

**Evidence.** The shared cases in `packages/identity/src/testing/contract.ts` run against memory and against Postgres (`packages/db/src/identity-store.test.ts`).

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

## Principal key rechecks take turns in the queue

**Problem.** A recheck of the principal key rule reads everything a principal holds, then marks or clears each instance. Run inline from the indexer, two rechecks for one principal could overlap, and one that read the holdings before a budget increase could finish last and clear the mark the newer one set. That restores service to a mandate that breaks the rule and resumes its parked jobs.

**Options.**

1. A database lock per principal around the recheck. It serializes the two, but nothing retries a failed chain read, and nothing hears of one that keeps failing.
2. A version on each mark, so an older reading cannot overwrite a newer one. It needs a version the chain does not give us for the whole of a principal's holdings, and still no retries.
3. A queue task, `compliance:recheck`, on one queue per principal, with one job key per principal in replace mode.

**Decision.** Option 3.

- The queue and key are principal scoped, so every project of one principal shares them and the rechecks run one at a time.
- The job carries no reading. It reads the holdings when it runs, so a recheck still waiting stands for every event after it, and replace mode folds those events into it.
- An event that arrives while a recheck runs gets a job of its own, because the queue gives a running job's key to the new job. It runs after, on a fresh reading.
- The principal comes from the job's tenant, never from its payload.
- A failed or timed out port call is retryable on the handler curve and changes nothing. At the last try the job writes a dead letter and alerts, because the mandate's state may then be stale.
- `scheduleRecheck` is called in the transaction that books a mandate event, so the job exists only if the event does.

**Trade offs and risks.**

- A burst of events costs at most one running and one waiting recheck per principal.
- An event folded into a job that is waiting on a retry takes that job's remaining tries and delay, rather than starting fresh.
- The indexer does not call `scheduleRecheck` yet. That lands with the store under the indexer scan.

**Evidence.** `packages/payouts/src/worker/compliance-recheck.test.ts`: `rechecks for one principal never overlap, while another principal runs`, `an older reading cannot undo a newer one`, `an event during a running recheck still gets a recheck of its own`, and `a recheck that keeps failing reaches the dead letter path and alerts`. All three ordering tests fail with the queue name taken away.
