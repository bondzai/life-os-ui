# The job queue — one table, one claim, and a lease

Everything background on this box used to be a poll loop holding its work in a local variable. A
sweep read wallets and sent alerts inline; the digest built and sent a brief inside the hour it was
due in; the snapshot sampled net worth and logged whatever went wrong. That is survivable while the
work is a *read*. It stops being survivable the moment a piece of work writes or sends, because then
"did it happen?" has no answer anywhere (`core/crates/lyra-db/src/jobs.rs:1-10`).

The queue makes a piece of work a **row**: something that can be retried, backed off, inspected,
reclaimed after a `kill -9`, cancelled from a phone, and seen on a page. It lives in the same SQLite
file as everything else, and that co-location is the reason it is not Redis — "mark this done and
enqueue the reply" is one commit here and a transactional outbox with a page of machinery anywhere
else (`jobs.rs:419-422`).

> **The code is the authority on what kinds exist.** `core/crates/lyra-api/src/jobs/mod.rs:269-275`
> registers them and a test asserts the list (`mod.rs:1101`). This document explains the model and
> the decisions; it does not try to stay in sync with a list a new handler changes.

Two crates, split on purpose. `lyra-db::jobs` owns the table, the claim, the lease and the backoff —
pure SQL a test can drive with a pinned clock. `lyra-api::jobs` owns the loop, the timers, the
supervisor and the handlers. Everything with a `Duration` in it is on the API side.

---

## 1. What moved onto it, and what that fixed

| Was | Now | What the loop could not do |
|---|---|---|
| Range alerts sent inline, then the new position state saved regardless (`alert_loop.rs:204-231`) | `deliver.telegram` queued **before** `save_positions` | A send that hit a router reboot was lost *permanently*: the transition had already been consumed, so the next sweep saw no change and said nothing |
| The digest built and sent inside `maybe_digest` | `digest.daily:<day>` (`alert_loop.rs:330-356`) | `digest_due` gates on `digest_hour == Some(now_hour)`, so retrying stopped when the clock left 08:00. An outage that outlasted the hour lost the day, silently |
| `maybe_snapshot` sampling on an interval | `snapshot.networth:<bucket>` (`alert_loop.rs:444-448`) | A failure meant waiting a whole interval — a thirty-second upstream blip cost four hours of series |
| Nothing at all | `schedule.tick:<day>` (`schedule.rs:1-18`) | A due habit reached you only if you opened the page or asked `/today` — a recurrence you set up because you forget things depended on you remembering to ask |

The sweep itself still runs in-process on its clock (`alert_loop.rs:7-9`). What changed is that the
tick now decides work is *due* and the queue decides when it actually happens. The alert enqueue is
deliberately **keyless**: `rules::evaluate` only emits on a transition, so the dedupe that matters
already happened, and a position that leaves range, returns, and leaves again has two things to say
rather than one (`alert_loop.rs:221-224`).

`LYRA_JOBS=off` stops the workers and the reaper (`mod.rs:603-607`), for the case where a box is
misbehaving and the question is whether the queue is the reason.

The four kinds, as the handlers declare them — each has a `job(...)` builder that is the only way to
construct one, so the lane, the key and the attempt budget cannot be assembled separately at a call
site:

| Kind | Lane | Attempts | Key | Notes |
|---|---|---|---|---|
| `deliver.telegram` | `deliver` | 5 (default) | none | Goes through `Channels`, so a box with Discord configured gets both; "delivered" means delivered *somewhere*. Wraps the send in `once("sent")`. An unconfigured box **completes** the job and records why, rather than failing on every alert the box ever tries (`deliver.rs`) |
| `digest.daily` | `batch` | 12 | `digest.daily:<day>` | The day is the caller's idea of today, carried in the payload. Stamps `digest_day` itself, so the flag and the send cannot disagree (`digest.rs`) |
| `snapshot.networth` | `batch` | 6 | `snapshot.networth:<now / interval>` | The tick's interval check preserves the *spacing* between samples; the key removes duplicates inside one window. Neither does the other's work (`snapshot.rs`) |
| `schedule.tick` | `interactive` | 4 | `schedule.tick:<day>` | Reads `schedules` and enqueues a `deliver.telegram` follow-up. Nothing due is a success and not a message. Silent unless `HABITS_NUDGE_HOUR` is set (`schedule.rs`) |

## 2. The schema and the states

Migration v5→v6 creates `jobs` and `job_effects` with four indexes
(`core/crates/lyra-db/src/migrations.rs:210-262`); v6→v7 adds `idx_jobs_updated`, which is what
`recent()` actually sorts on (`migrations.rs:263-270`). Nothing in `jobs.rs` creates or alters a
table.

Two facts shape the columns, and both are about crashes rather than throughput. A job is claimed by
**lease** — `worker` plus `leased_until` — because that is the only thing that tells a `kill -9`
apart from slow work; a bare `status = 'running'` would strand the row forever with nothing to say
who was meant to be running it. And `run_at` carries the backoff, the schedule and the "not yet" of
a delayed retry in one column, so the claim is always "the oldest runnable job" and never a join
(`migrations.rs:198-205`).

```
enqueue ──▶ queued ──claim──▶ running ──┬── complete ──▶ done
              ▲                          ├── fail (budget left) ──▶ queued, run_at = now + backoff
              │                          ├── fail (exhausted or permanent) ──▶ failed
              └── reap (lease expired) ──┘
    queued ──cancel──▶ cancelled
    failed / cancelled ──retry──▶ a NEW queued row
```

`done`, `failed` and `cancelled` are terminal; nothing moves out of them and `finished_at` is set
exactly once on the way in (`jobs.rs:120-160`). **`attempts` is incremented by the claim, not by the
handler** (`jobs.rs:236-238`), so a worker that dies without reporting anything still burns an
attempt and a job that kills its worker every time terminates instead of spinning forever.

`job_effects` is keyed `(job_id, key)` and cascades on delete, which is what keeps `prune` a single
statement (`migrations.rs:230-241`).

## 3. Why claiming is safe

The claim is a **single `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING …` in autocommit**
(`jobs.rs:448-497`). Not a transaction — and the reason is the sharpest SQLite fact in the design
(`jobs.rs:12-27`):

`busy_timeout` does not save a deferred transaction that starts as a reader and then tries to
upgrade. A `BEGIN` that runs a `SELECT` first takes a read lock; when the following `UPDATE` asks to
upgrade and another connection already holds the write lock, SQLite returns `SQLITE_BUSY`
*immediately* rather than waiting, because waiting could only deadlock — both sides holding a read
lock and wanting a write. So the obvious "`SELECT` a job, then `UPDATE` it inside `BEGIN`" is
**less** reliable under contention than no transaction at all.

One statement takes the write lock from its first instruction, so the busy timeout applies the whole
way through, and the subquery is re-evaluated under that lock. Two workers racing therefore resolve
to one winner and one `None`. That is the correctness argument: not isolation from a transaction,
but the fact that the read and the write are the same statement under one lock.

Where a claim genuinely must be atomic with something else the rule is `BEGIN IMMEDIATE`, never bare
`BEGIN`, for exactly the same reason — `complete()` writes from its first statement
(`jobs.rs:515-558`).

The second half of safety is the lease guard. Every terminal write carries
`WHERE id = ? AND worker = ? AND status = 'running'` — heartbeat (`jobs.rs:499-513`), complete
(`jobs.rs:530-534`), fail (`jobs.rs:592-596`). A process that was reaped and then comes back to
life — a paused VM, a long GC, a laptop lid — cannot finish a job that now belongs to someone
else. Its
`complete()` returns
`false`, nothing is written, no follow-up is enqueued, and it is expected to drop the work
(`mod.rs:448-454`).

That guard is also why a worker name carries the pid: `deliver-0@1234` (`mod.rs:636-652`). Two
`lyra-api` processes on one SQLite file both have a `deliver-0`, the guard would compare equal
across them, and the protection would be gone. Two processes on one database is not hypothetical —
it happens for a few seconds during any overlapping restart.

**Delivery is therefore at least once, and that is not negotiable.** A worker can always die between
doing a thing and recording that it did. `JobCtx::once` and `job_effects` narrow that window to the
width of one `INSERT`; they do not close it (`jobs.rs:38-43`, `mod.rs:194-214`). `remember` uses
`ON CONFLICT DO NOTHING` and returns the **first** writer's value, because in the window a lease
cannot close, both runs must agree on the answer (`jobs.rs:790-813`). A step that must never repeat
needs an idempotency key at the far end as well.

The lease is 60s by default (`jobs.rs:60-64`) and the heartbeat is a third of it, derived from the
*worker's* lease rather than the default — a heartbeat pinned to the default under a shortened lease
would tick after the lease it was meant to renew had already expired (`mod.rs:46-58`). The heartbeat
shares the handler's task rather than running in its own, so a heartbeat cannot outlive a panicking
handler and hold a lease for a job nobody is running (`mod.rs:500-534`).

## 4. Idempotency, and what "already queued" means

`idempotency_key` is nullable, and the index over it is **unique and partial**:

```sql
CREATE UNIQUE INDEX idx_jobs_idempotency ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL
```

(`migrations.rs:252-258`.) Partial because NULL means "this job is not deduplicated", and without
the predicate at most one such job could exist at a time.

To a caller, `enqueue` returns `Enqueued { id, created }` (`jobs.rs:250-258`). `created == false`
means an identical key was already queued and this call did nothing — **a success, not a conflict**.
The id handed back is the id of the job that is really going to run, not of a row that does not
exist, so the caller can watch the right thing (`jobs.rs:850-867`). The tick uses that directly:
`enqueue_once` logs only when a job is new, because every tick in the window re-enqueuing the same
key is the normal case (`alert_loop.rs:359-375`).

This is what makes the index the "did I already do this today" flag rather than a variable some code
has to keep in step. The digest tick runs every thirty seconds all hour; 120 enqueues of
`digest.daily:2026-09-21` are one job, and a test asserts exactly that (`digest.rs:161-176`).

When the key is released is the subtle part:

| Terminal status | Key | Why |
|---|---|---|
| `done` | **kept** | This is the case the key exists for. A delivered `digest.daily:2026-09-21` should stay claimed for the rest of the day |
| `failed` | released (`jobs.rs:582-595`) | A job that exhausted its attempts has emphatically *not* done the work. Holding the key meant the retry — a re-tick, a button, the user simply asking again — hit `DO NOTHING` and got back `created: false` and the id of a corpse. The work vanished and the caller was told everything was fine |
| dead-lettered by the reaper | released (`jobs.rs:620-624`) | Same reason; a job that took its worker down with it never reported anything |
| `cancelled` | released (`jobs.rs:726-731`) | You cancelled it in order to ask again |

## 5. Backoff and the dead letter

Backoff is exponential from 10s, doubling, capped at 900s, with **no jitter** — jitter breaks up a
thundering herd of independent clients, and this is one process with four workers (`jobs.rs:66-70`,
`303-313`). Cumulative wait by attempt count:

| Attempts | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 |
|---|---|---|---|---|---|---|---|---|
| Seconds spanned | 10 | 30 | 70 | 150 | 310 | 1270 | 3070 | 4870 |

*n* attempts means *n − 1* waits: the last failure is terminal and is not followed by one
(`jobs.rs:575-580`). `DEFAULT_MAX_ATTEMPTS` is 5, which is 150 seconds (`jobs.rs:53-58`). A job
reaches `failed` when its attempts are spent or when its handler returned `Permanent`; a `Permanent`
failure is set aside immediately with its remaining attempts *unspent*, because retrying an
unparseable payload four more times only writes the same log line four more times
(`jobs.rs:260-269`, `mod.rs:84-109`).

**A dead job's row is kept because it is the evidence.** `last_error` (truncated to 500 characters —
a handler that hands back a megabyte of provider HTML should not put a megabyte in every row of
`/jobs`, `jobs.rs:904-916`), the attempt count, and the fact that it happened at all are the whole
answer to "why did the brief not arrive on Tuesday". That is also why `retry` **copies** rather than
resetting the failed row: the copy carries the work — kind, lane, payload, priority, attempt
budget — points back through `parent_id`, and is keyed `retry:<original id>` so a button pressed
twice is one retry (`jobs.rs:742-772`). Resetting would be the obvious build and it would destroy
the only reason the row was kept.

Terminal rows are pruned after fourteen days, by the reaper, hourly (`mod.rs:73-75`, `588-594`,
`jobs.rs:652-663`). Long enough to answer "what happened on Tuesday", short enough that the table
stays small forever. One cutoff covers `done`, `failed` and `cancelled` alike: a dead row is
evidence for exactly as long as a successful one, not longer. Keeping failures around longer would
be reasonable and is simply not what the code does.

## 6. Lanes, seats, and the supervisor

Lanes are **not** priorities. `priority` orders work *within* a lane; a lane is a separate queue
with its own workers (`jobs.rs:85-99`). The counts are an isolation guarantee, not a throughput
estimate: a ten-minute import must not be able to sit in front of the answer someone is waiting on,
and a Telegram outage retrying for minutes must not occupy the worker that answers commands
(`mod.rs:8-14`).

| Lane | Workers | Persona on the Agents page | For |
|---|---|---|---|
| `interactive` | 2 | Runner 1, Runner 2 | Someone is waiting. Short work only |
| `batch` | 1 | Analyst | Nobody is waiting: sweeps, digests, imports |
| `deliver` | 1 | Relay | Outbound messages, and it keeps trying |

Set in one place (`mod.rs:615`). The personas come from `persona()` (`mod.rs:663-678`), which is
deliberately a *table* rather than a formatting rule: today a lane is the only thing distinguishing
one worker from another, and when agents start differing by what they can actually do each declares
its own name and role there. The ordinal only appears when a lane has more than one seat — "Relay 1"
alone is a number answering a question nobody asked.

Each worker is started under `supervise` (`mod.rs:686-720`), and that exists because of a real
outage. `tokio::spawn(worker.run_forever())` dropped the `JoinHandle`, so a panic anywhere in a
handler ended that task **silently and permanently**: `run_forever` never returns, nothing was
awaiting it, nothing restarted it. One `unwrap` on one malformed provider payload and the deliver
lane was dark for the life of the process — jobs claimed, leases expiring, the reaper dutifully
requeueing them for a worker that no longer existed.

Supervision rather than `catch_unwind`, because a panic mid-job should abandon that job rather than
resume inside it. The job is not lost: its lease expires, the reaper requeues it, and that is the
path that already existed for a hard kill. A panicking handler is just a very small crash. Restarts
wait 5s so a handler panicking on every job cannot spin (`mod.rs:680-684`), and the restarted worker
re-announces itself, because the page should show a worker that came back rather than one that
quietly stopped reporting (`mod.rs:537-550`).

## 7. The reaper

One task, every 30 seconds, which is the recovery latency after a crash (`mod.rs:569-596`,
`REAP_EVERY` at `:71`). It is the single point of recovery from a hard kill and the path never
exercised in normal operation, which is exactly why its tests live down in `lyra_db::jobs`.

One tick is two autocommit statements, in this order (`jobs.rs:613-650`):

1. **Dead-letter** every `running` row whose lease expired with `attempts >= max_attempts`, with
   `last_error` saying the worker did not survive this job. These are the hard ones: a job that
   takes its worker down never reports a failure, so `Reaped::dead_lettered` is the only place it
   appears.
2. **Requeue** every remaining `running` row whose lease expired, with `run_at = now + 5`. The delay
   is small on purpose — a lease expires because a worker *died*, usually a restart, and the point
   of the queue is that the work resumes. It exists only so a job that kills its worker every time
   cannot spin the machine, and it is bounded anyway because every claim burns an attempt.

Order matters: the requeue has no attempts predicate of its own, so the exhausted rows must be set
aside first. Two statements rather than one transaction because each is idempotent and a crash
between them leaves work the next tick does — a transaction would buy an atomicity nothing here can
observe.

Every 120th tick, the same task prunes (`mod.rs:588-594`). Reaping and pruning share a task rather
than having two timers, off the back of the tick that is already awake.

## 8. Adding a job kind

A recipe, in order. Nothing here needs a migration: `jobs` is generic and the payload is JSON.

1. **Name the kind.** Dotted, lowercase, `<area>.<thing>`: `deliver.telegram`, `digest.daily`,
   `snapshot.networth`, `schedule.tick`. It is written into every row, so it is a **wire
   contract** — renaming one strands the jobs already queued under the old name (`mod.rs:113-117`).
   Put it in a `pub const KIND` and use that everywhere; it was a bare literal in four places once.
2. **Add a module** under `core/crates/lyra-api/src/jobs/` and `pub mod` it at `mod.rs:30-33`.
3. **Implement `Handler`.** `kind()` returns `KIND`; `run()` returns `HandlerResult`. Read required
   payload fields with `ctx.require_str` / `ctx.require_i64`, which fail **permanently** — the
   payload is written at enqueue and no amount of retrying grows a field (`mod.rs:154-176`).
4. **Classify your failures.** `Permanent` means the *job* was wrong: an unparseable payload, an
   argument that can never validate, a configuration that is absent rather than flaky.
   `HandlerError::Retry` means the *world* was wrong. A bare `?` is `Retry`, which is the safe
   default: an unclassified error is far more often a network blip than a permanently malformed job,
   and guessing wrong costs a delay rather than lost work (`mod.rs:84-109`).
5. **Pick the lane.** `Interactive` if something short is being waited on, `Batch` for reads and
   sweeps, `Deliver` for outbound sends. Do not send from inside the handler that produced the text:
   enqueue `deliver::job(...)` as a follow-up instead, or a Telegram outage retries whatever
   expensive thing produced the message (`deliver.rs:12-14`, `schedule.rs:101-104`). There is no new
   lane without new workers — `spawn` starts a fixed set (`mod.rs:615`), and a job in a lane nobody
   reads is never claimed.
6. **Pick `ATTEMPTS` from the window you have to cover**, using the table in §5, and write the
   arithmetic down next to the constant. The default 5 is 150 seconds. See §9 — this is the number
   that turns a queue migration into a regression.
7. **Decide whether it needs an idempotency key.** If the work is "at most once per period", key it
   on the *period* and never on the instant: `digest.daily:<day>` (`digest.rs:41-43`),
   `snapshot.networth:<bucket>` where the bucket is `now / interval` (`snapshot.rs:46-49`). If the
   work is a genuine event — an alert on a transition — leave it keyless.
8. **Write one `pub fn job(...) -> NewJob` builder** in the same module, fixing kind, lane, key and
   `max_attempts` together. Every enqueue site used to assemble those four separately, and the
   attempt budget is exactly the one whose omission is a regression; a builder is where it cannot be
   forgotten (`digest.rs:60-70`).
9. **Wrap anything unrepeatable in `ctx.once("step", …)`** — a send, a post to someone else's API.
   After a reclaim the step is skipped and the first run's answer is replayed (`mod.rs:194-214`,
   `deliver.rs:118-138`).
10. **Register it** in `handlers()` (`mod.rs:269-275`) and add the kind to
    `the_registry_names_every_kind_this_binary_can_run` (`mod.rs:1101`). Skipping this is the
    commonest way a queue goes quiet: the job is claimed, fails with "no handler", and
    dead-letters — permanently and by design, since no amount of waiting conjures a handler into
    the binary (`mod.rs:399-414`).
11. **Enqueue it from somewhere**: the sweep tick through `enqueue_once` (`alert_loop.rs:364`), a
    bot command, an HTTP handler, or a parent handler's `ctx.enqueue` — which is written in the
    **same commit** as the parent's completion, so the queue cannot hold a job that ran and a
    follow-up that was never queued (`mod.rs:186-192`, `jobs.rs:550-556`).

Then it appears, without touching any of those files:

- **Agents page.** The lane's worker reports `Claimed` and `Finished` to the `Fleet`
  (`mod.rs:424-439`), which folds them into in-memory state and broadcasts a frame to every open
  socket (`agents.rs:181-257`). The page reads `/api/agents/stream` over a WebSocket, falls back to
  `GET /api/agents`, and polls `GET /api/jobs` separately for the counts and the recent tape —
  deliberately not streamed, because a queue depth is a `COUNT` over a table and pushing it down
  every socket on every event is one query per listener per job (`agents.rs:268-275`). Routes at
  `main.rs:110-115` and `:219`; the client is `src/core/hooks/use-agent-stream.ts` and
  `src/pages/agents.tsx`.
- **Telegram.** `/jobs`, `/retry <id>`, `/cancel <id>` are generic over kind (`bot_jobs.rs`, wired
  at `tgbot.rs:363` and `:388`). Ids are shown as six characters and a prefix is accepted, but an
  ambiguous one is **refused rather than guessed** — retrying the wrong job re-sends a message you
  did not mean to send (`bot_jobs.rs:6-11`, `82-108`).
- **The settings page.** A failure of *any* kind is recorded as `last_error` by the worker and
  surfaces through `/api/wealth/alerts` (`mod.rs:477-479`, `wealth.rs:1744-1751`).

## 9. Traps

**An attempt budget must cover the window it replaced.** This is the one that nearly shipped. The
digest loop retried on every 30-second tick for the length of the digest hour — 120 attempts across
3600 seconds. Moving it to the queue with the default 5 attempts would have replaced an hour of
trying with **150 seconds** of it, which is worse in every case anyone cares about. `ATTEMPTS = 12`
spans 4870s — about eighty minutes, comfortably outlasting the hour — and still ends, so a
permanently broken channel dead-letters instead of retrying forever (`digest.rs:45-58`). A test
catches the regression by asserting the span, not the constant:
`a_refused_brief_is_still_trying_after_the_hour_has_passed` (`digest.rs:187-230`). Budgets are also
compared against each other where the judgement differs — `snapshot.networth` gets 6, and a
compile-time `assert!` fails the *build* if a sample ever tries harder than the brief
(`snapshot.rs:28-44`).

Do the arithmetic from the table above, and remember that **n attempts means n − 1 waits** —
`fail` dead-letters on the last attempt instead of scheduling another one. That off-by-one had
produced two wrong comments, since corrected: `DEFAULT_MAX_ATTEMPTS` described five attempts as
"about twenty minutes" when they span 150 seconds, and `digest.rs`'s cumulative list ran one entry
too far, to 5770, by counting a wait that never happens. Both said something the backoff cannot do,
and both were believed for a while, which is the argument for computing a budget rather than
quoting one.

**Every handler must report its failures, which is why no handler does.** The first version had each
handler remember to write to the alert meta, and alert delivery — the kind that mattered most, and
the one that had always reported its failures — was the handler that forgot. Moving alerts onto the
queue quietly made the settings page blind to exactly the failures the move set out to catch.
Recording now lives in `Worker::reporting_to`, once, for every kind (`mod.rs:323-335`), and the test
asserts it at the worker using `deliver.telegram` on purpose (`mod.rs:1051-1086`). A rule every
handler must remember is a rule the next handler forgets.

**`ON CONFLICT(idempotency_key) DO NOTHING` does not parse** against a partial index. The conflict
target has to repeat the index predicate verbatim —
`ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL` — or SQLite cannot tell which index
is meant. Review does not catch this; only running it does (`jobs.rs:820-828`).

**Spell `status = 'queued'` as a literal.** SQLite only uses a partial index when the query's
`WHERE` provably implies the index's, and a bound `?` proves nothing. Every statement that wants
`idx_jobs_claim` writes the predicate out (`migrations.rs:242-249`).

**Never hold a database transaction across a network call.** SQLite has one writer. A handler that
opens a transaction and then waits on HTTP blocks every writer on the box for the duration,
including the `/api/entities` POSTs the web app makes, which exhaust their 5s busy timeout and
return 500s. The symptom looks like "the app broke" and the cause is in a worker three files away.
Do the slow thing first, then write (`mod.rs:16-22`). Relatedly, workers hold a pool connection only
for the claim, each heartbeat and the completion — the pool is eight and the HTTP server needs it
(`mod.rs:24-28`).

**A retry does not inherit an idempotency key**, because a failed job already released it. The one
consequence worth knowing is the digest: retrying a dead brief *during* the digest hour can race the
tick's own enqueue and send it twice. Outside that hour it cannot (`jobs.rs:752-756`).

**"Today" belongs to the caller.** `digest::key_for` takes the day rather than computing it: the box
may run UTC while the user does not, in which case "today" here and "today" on the phone disagree
for part of every day, so whoever knows the answer says it (`digest.rs:36-43`).

**`complete()` returning `false` is not an error.** It means the lease went while the handler ran;
someone else has the job and the work has already been redone or is about to be. Log it and discard
the result — writing anything to the row from there is the bug the `worker = ?` guard exists to stop
(`mod.rs:440-463`, `:488-495`).

**A `schedules` row is not a job and never becomes one.** `nextDue` is rendered to the user on the
habits page, so a failed job writing a backoff into it would make them watch their chores silently
slide (`migrations.rs:207-209`, `schedule.rs:7-12`).

**Nothing sends `Report::Stopped` today.** The variant exists and `Fleet` handles it
(`agents.rs:250-253`), but no worker emits it, so a worker that goes away is seen through a stale
`last_seen` rather than disappearing from the page. The code is the authority here: `agents.rs` is
the only place a frame is produced.

## See also

- [`docs/alerts.md`](./alerts.md) — what gets sent, and the channels `deliver.telegram` fans out to
- [`docs/api-server.md`](./api-server.md) — where the workers are started from
- [`docs/telegram.md`](./telegram.md) — the bot the queue commands live in
- [`docs/assistant-roadmap.md`](./assistant-roadmap.md) — Stage D, and what is still missing from it
- [`docs/deployment.md`](./deployment.md) — `LYRA_JOBS`, `HABITS_NUDGE_HOUR` and the settings
