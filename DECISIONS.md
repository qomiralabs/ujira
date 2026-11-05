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
