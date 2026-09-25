# The assistant roadmap

**Written 2026-09-21.** This reconciles four independent designs — MCP coverage, the Telegram
command surface, a job queue, and a documentation audit — into one ordered plan.

The goal it serves, in the user's words:

> Build Lyra as my personal assistant. Phase 1: command it from Telegram. If tasks can connect by
> any agents it must work like a job queue to scale in future.

The four designs were produced in parallel and could not see each other. Where they agreed, this
document states the agreement once. Where they contradicted each other, §1 names the contradiction
and picks a side, because a contradiction smoothed over is a decision made by accident.

---

## 0. What is actually true today

Everything below is verified against the tree at `7ee4306`, not inferred from the docs.

| | Today |
|---|---|
| **MCP** | `lyra-mcp` exposes ten tools, all wealth. Exactly one writes (`save_analysis`), and a test asserts the count. The binary refuses to boot with signing material in its environment and refuses any transport but stdio. Nothing in it can see a task. |
| **Telegram** | `lyra-api/src/tgbot.rs` already pulls commands **in** — 25s long poll, owner pinned by `TELEGRAM_CHAT_ID`, offset acked after the reply, `MAX_PER_POLL = 5`. Eleven commands, all wealth reads. |
| **Alerts out** | `lyra-alerts::Channels` fans one message to Telegram and Discord; any channel succeeding counts as delivered. |
| **Inference** | **Only in the browser.** `src/core/ai/ai-client.ts:33`. Nothing on the server can call a model. |
| **Background work** | Two hand-rolled poll loops, `alert_loop.rs` and `tgbot.rs`. No queue, no durable work item, no retry, no crash recovery for in-flight work. |
| **Life-OS data** | One `entities` table for every type; `metadata.projectId` links a task to a project or goal. `schedules` is entity recurrence — no payload, no worker, no attempts, no lease. |

Two gates constrain every phase below. **Parity**: `core/parity.toml` diffs the wealth endpoints
against a Python oracle at 0.5% tolerance, so a gated response cannot grow a field. **Budget**:
the frontend is 298 tests passing and *exactly* 59 lint problems; both numbers mean something only
while they do not move.

---

## 1. Where the four designs contradicted each other

### 1.1 Three names for "a thing that can be done" — one path, or three?

MCP proposed a `Change` enum applied by `lyra_db::life::apply()`. Telegram proposed a `lyra-verbs`
crate with its own `Verb` trait and registry. The queue proposed a `Handler` trait with its own
dispatch. Read together, that is three abstractions that each know how to write a row.

**Resolved: one write path, three envelopes around it.**

```
grammar / MCP tool / job payload
              │
              ▼
          Change            ← the unit of work. Serialize + Deserialize.
              │
              ▼
  lyra_db::life::apply(pool, owner, change)   ← the only thing that writes a life row
```

`Verb` is what a human types. `Job` is a durable envelope carrying a `Change` across a restart.
`Change` is the work itself, and `apply()` is the single function that performs it. Ownership
checks and audit rows live inside `apply()`, so they cannot be bypassed by whichever caller
someone forgets about — which is the failure mode three parallel implementations guarantee.

This is why `apply()` gets built in the phase that adds the first write, even though nothing
queues yet. Retrofitting it once three call sites exist is the expensive version.

### 1.2 Two enums classifying the same risk

MCP proposed `Capability { Read, WriteOwnData, Reach }` (a tool's blast radius). Telegram proposed
`Risk { Safe, Additive, Mutating, Destructive }` (how much ceremony a command deserves). Both are
hand-maintained classifications of the same set of operations, and two hand-maintained
classifications of a security property drift — silently, and in the direction of whoever was in a
hurry.

**Resolved: keep `Capability` as the only stored classification; derive ceremony from the
`Change` variant.**

`Capability` lives on `ToolDef` and on `Verb`, and it is what the registry tests assert over.
Confirmation policy is a *function*, `confirmation_for(&Change)`, not a second field: `CreateEntity`
is additive and never confirms, `UpdateEntity` / `CompleteEntity` are reversible by `/undo`,
archiving confirms. Deriving the policy from the data means a new `Change` variant cannot be added
without the compiler making someone classify it.

### 1.3 One MCP binary, or two?

The docs audit recommended **two binaries** — `lyra-mcp` stays read-only and wealth-only, a new
`lyra-mcp-assistant` carries every write — on the grounds that the invariant's value is that it is
checkable without reading the code. The MCP design recommended **one binary** with a `Capability`
model and a `LYRA_MCP_WRITE` opt-in. The queue design wanted **no queue tools at all** beyond
read-only ones, to keep "exactly one tool writes" literally true.

**Resolved: one binary, capability-gated, writes off by default.**

The docs audit is right about what matters — a guarantee you have to audit tool by tool degrades
quietly — but wrong that a second binary is the cheapest way to keep it. With `LYRA_MCP_WRITE`
unset, the desk registered in a client **cannot list a write tool at all**, which is the same
property the second binary buys, without duplicating the startup guard. That guard is the last
piece of this crate that should exist twice.

The replacement guarantee has to be as checkable as the sentence it replaces, so it is two facts,
not an audit:

1. **No tool in any domain can sign, because `Capability` has no `Sign` variant.** The compiler
   refuses a signing tool where the old test only noticed one after the fact.
2. **No tool in `Domain::Wealth` writes except `save_analysis`.** One test, one line, and unlike
   the old assertion it stays true as the life surface grows — which is exactly the property that
   made the old test worth having.

The queue design's position survives intact inside this: `list_jobs` and `get_job` are
`Capability::Read`, and `enqueue_job` is simply not built in phase 1. Under the capability model it
becomes admissible later without touching the wealth invariant — which is the point of moving from
a count to a classification.

**This one is genuinely hard to walk back once tools are written**, so it is decision **D1** below.

### 1.4 Is server-side inference in Phase 1?

Telegram recommended a hybrid — grammar first, a model behind `LYRA_AI_ENDPOINT` that may only
emit a *proposal*. The queue wanted a `lyra-agent` crate with the MCP registry as its in-process
tool surface, but recommended shipping the six inference-free job kinds first. The docs audit said
flatly: no for Phase 1, and write the constraint down.

**Resolved: out of Phase 1, in as the last phase, and it lands once.**

All three agree the first useful thing needs no model. The latent contradiction is that Telegram
wanted a ~40-line client inside `lyra-verbs/src/intent.rs` and the queue wanted a 200–300 line
`lyra-agent` crate — two OpenAI-compatible clients in one workspace, which is one too many. When it
lands it is **one crate, `lyra-agent`, with two callers**: the tgbot intent parser and the
`ask.llm` job handler.

The execution rule is Telegram's and it is not negotiable: the model is a parser, never an
executor. It may return a `Proposal` naming a verb in the registry, whose arguments face the same
validation a typed command faces. A proposal naming an unknown verb is rejected before dispatch.

### 1.5 Does every Telegram command go through the queue?

The queue design put `capture.note` on the queue in its second phase, keyed by the Telegram
`update_id`, because `tgbot.rs` acks the offset *after* replying and a crash therefore re-runs one
command — harmless while all eleven commands are reads, a duplicate row the moment one writes.
Telegram's design wanted fast verbs inline, arguing that a capture costing two messages stops being
a capture.

Both arguments are correct, and they do not actually conflict once you notice what the queue was
buying: replay-safety, not durability. The write commits to the same SQLite file the queue lives
in, so the transaction *is* the durability.

**Resolved: fast verbs run inline; replay-safety comes from a deterministic id, not from the
queue.** `capture` mints its entity id from the Telegram `update_id`, so the replay is an
`INSERT OR IGNORE` that does nothing. Slow verbs (`Cost::Slow`) enqueue and the loop acks
immediately. A verb that mis-declares itself `Fast` is abandoned at 2s and enqueued instead, so a
wrong `cost()` costs one delayed answer rather than a wedged poll loop — `handle().await` runs
inside that loop, and everything behind a stalled verb waits on it.

### 1.6 Who does the assistant write as — refuse, or degrade?

MCP wanted `LYRA_MCP_OWNER` or a single `users` row, else **refuse to start**. Telegram wanted
`TELEGRAM_OWNER_USER_ID` with a **read-only degrade**.

**Resolved: one resolver, two policies, both deliberate.** `lyra_db::life::resolve_owner()` is the
single implementation. `lyra-mcp` refuses to boot, because a desk that answers a model with an
empty task list is telling a lie the model cannot detect — the same refusal
`LivePortfolio::resolve` already makes rather than reporting $0 for a misconfigured server. `tgbot`
degrades to read-only and says so, because the eleven wealth commands are still worth having and
killing the bot over a typo in one variable costs more than it protects.

### 1.7 May the assistant delete?

MCP: no delete tools at all, `entity_update(status: "archived")` is the delete, which keeps
`destructiveHint: false` true for the whole registry. Telegram: `archive` **and** `delete` verbs,
tagged `Destructive` and always confirmed.

**Resolved: nothing deletes in phase 1.** The model gets no delete tool and Telegram gets
`/archive` only. The asymmetry Telegram proposed — a human typing `/delete` is not a model choosing
to — is real, but what makes either recoverable is the audit row, and that does not exist yet.
A true `/delete` waits until it does. This is decision **D4**.

### 1.8 `schedules` is not the queue

All four designs agree, unprompted, which is worth recording as settled rather than re-litigating.
`schedules` holds `entityId`, `recurrence`, `nextDue`, `lastCompleted`, `isActive`; its `nextDue`
is *rendered to the user* on the habits and chores pages. It has no payload, no attempts, no
worker, no lease and no terminal state. If a failed job rewrote `nextDue` as a backoff, the user
would watch their chores silently slide.

The bridge is one-directional: a `schedule.tick` job scans `schedules` and *enqueues*. `schedules`
never learns the queue exists. `docs/core-engine.md` has been amended to say so, because it
currently presents `Schedule` in a way that reads exactly like a job table.

### 1.9 When the docs get written

The MCP design put all documentation in its final phase. The docs audit argued that `docs/mcp.md`
must be written **against the current ten tools, before the expansion**, because writing it
afterwards means never writing down what was traded away — and that `docs/jobs.md` must be written
**from merged code**, never before, on the evidence of the deleted `docs/openclaw-integration.md`: 191 lines
specifying a system nobody ever built, still sitting in `docs/` two phases later.

**Resolved: the audit wins, and this commit acts on it.** `docs/mcp.md`, `docs/telegram.md` and
`docs/alerts.md` are written today against what runs today. `docs/jobs.md` is written when the
queue merges.

---

## 2. The roadmap

Each item is **DECISION-INDEPENDENT** (buildable now, whatever the user decides) or
**DECISION-BLOCKED** (needs one of the four answers in §3). Sizes are S/M/L in the same spirit the
four designs used them.

### Stage A — Foundations (nothing user-visible, everything else rests on it)

| # | Item | Size | Status |
|---|---|---|---|
| **A1** | **Chunking and a reply formatter.** `chunk(text, 3500)` splitting on line boundaries with `(1/3)` markers, wired into the tgbot reply path and the alert sender. A `Reply` type with list / echo / error shapes and a seven-row cap. | S | **SHIPPED** `7b3571f` — split on a line boundary, not clamped |
| **A2** | **The shared life store.** New `lyra-db/src/life.rs`, sibling to `wealth.rs`: `Entity` / `Tracker` / `Relation` / `Schedule` row types and their JSON projections, the owned-or-shared visibility rule in **one** implementation, keyset-paginated list queries, and `resolve_owner()`. `lyra-api` handlers keep their zod-port validation and delegate the rest. One new migration adds `idx_entities_owner_due`. | M | **SHIPPED** `ff04772` — `lyra-db/src/life.rs` |
| **A3** | **The jobs table and its store.** `MIGRATIONS[5]` creating `jobs` and `job_effects` with four indexes. `lyra-db/src/jobs.rs` behind a `Queue` trait: enqueue, claim, heartbeat, complete-with-follow-ups, fail-with-backoff, reap, prune, age. Nothing consumes it yet — it ships fully green with zero behaviour change. | M | **SHIPPED** `0e7e0c8`, fixed `749bc37` after QA |

**A1 is first because it is a bug fix, not a feature.** Telegram rejects anything over 4096
characters outright, and `digest.rs` is 1066 lines of string building pointed at a single
`sendMessage`; today an oversized brief vanishes into `delivered = false` in a log line.

**A3's claim is one statement in autocommit**, and the reason is the sharpest SQLite fact in any of
the four designs: `busy_timeout` does **not** save a deferred transaction that starts as a reader
and then tries to upgrade, so a `SELECT`-then-`UPDATE` claim inside `BEGIN` is *less* reliable
under contention than no transaction at all. `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING`
takes the write lock from its first instruction. Where the claim must be atomic with something
else, the rule is `BEGIN IMMEDIATE`, never bare `BEGIN`.

### Stage B — See (the assistant can look before it can act)

| # | Item | Size | Status |
|---|---|---|---|
| **B1** | **The capability model in `lyra-mcp`.** Replace `read_only: bool` with `Capability` + `Domain` on `ToolDef`; narrow the write-surface test to `Domain::Wealth`; fix the forbidden-substring test to match property *names* for `sign`/`seed`; add `WriteMode` to `Startup` and `registry(mode)`; wire `LYRA_MCP_OWNER`. Registry still ten tools, wire contract byte-identical. | M | **SHIPPED** `ff04772` — see the note below on D1 |
| **B2** | **The life-OS read surface over MCP.** `entity_list`, `entity_get`, `search_life`, `get_agenda`, `schedule_list`, `tracker_series`. Projections, keyset cursors, a default limit of 20 and a max of 100, and a ~64 KB frame budget checked in `tools_call`. Every one is `Capability::Read`. | M | **SHIPPED** `ff04772` — 7 tools, registry now 17 |
| **B3** | **`lyra-verbs` and the read verbs.** The crate: `Verb`, `Capability`, `Cost`, `Actor`, `Outcome`, a plain registry a test can enumerate. The eleven wealth commands re-expressed as verbs wrapping `wealth::bot_*` unchanged. New verbs `/today`, `/next`, `/inbox`, `/p <name>`, `/week`. Owner resolved at spawn, read-only degrade. | M | **PART SHIPPED** `3c9c30f` — verbs work; the `lyra-verbs` crate does not exist |
| **B4** | **The grammar.** `grammar.rs` porting `parseCapture` from `capture-protocol.ts:148`, with a test that reads the TS table and asserts every prefix and alias agrees. `dates.rs` for `tomorrow` / `friday` / `in 3 days` against `chrono::Local`. `@project` resolution by prefix against open projects and goals. **Still no writes** — the parse is echoed back, so the grammar can be judged before it can change anything. | M | NOT STARTED — **decision-independent and unblocked** |

`get_agenda` is the tool that makes Telegram feel instant: overdue, due today, in progress, habits
due, active schedules, next calendar events, in **one call** for the question the assistant asks
most of the time. Without it a model fires five list calls and spends its context on plumbing. It
must degrade to the local half with an explicit `calendar: null, reason: "not connected"` when the
Google token is absent or expired, rather than failing the whole call.

### Stage C — Act (the assistant can change something)

| # | Item | Size | Status |
|---|---|---|---|
| **C1** | **`Change`, `apply()` and the audit table.** The enum, the one function that writes, and `mcp_audit(id, ts, tool, change_kind, entity_id, args_digest, ok)` — a digest, never the arguments, for the same reason `StartupRefused::SigningMaterial` carries names and never values. `apply()` keeps its transactions short and maps `SQLITE_BUSY` to *"try again"*, not *"you got it wrong"*. | M | NOT STARTED — **blocked (D4)** |
| **C2** | **The MCP write surface.** `entity_create` (UUID minted server-side, `parentId` and `metadata.projectId` validated against a visible entity), `entity_update`, `entity_complete` (entity + schedule in one transaction), `habit_log`, `entity_link`, `schedule_set`. Three new invariant tests. **This is where the read-only guarantee formally changes, so it is one commit with the reasoning in the message.** | M | NOT STARTED — **blocked (D1, D4)** |
| **C3** | **The Telegram write verbs.** `capture`, `complete`, `snooze`, `focus_start`/`focus_stop` (a `trackers` row at `unit='focus-min'`), `archive`. Numbered handles persisted in `alert_state` under `tgbot:handles` with a 30-minute expiry. The `tgbot:pending` confirmation slot with `/yes` and `/no`. The `tgbot:undo` single-entry journal and `/undo`. Entity ids derived from the Telegram `update_id`, so an offset replay is a no-op. `COMMANDS` gains a category column and `/help` prints it grouped. | M | NOT STARTED — **blocked (D4)** |

After C3, texting `!call the accountant tomorrow @Accounts` from a bus stop creates the task, and
`/today` answers in one message. **That is Phase 1 delivered**, with no model anywhere in the path.

### Stage D — Scale (the queue starts carrying work)

| # | Item | Size | Status |
|---|---|---|---|
| **D1′** | **The worker runtime.** `lyra-api/src/jobs/`: the `Handler` trait, `JobCtx` (`once`, `enqueue`, `heartbeat`), the lane router, and a supervisor running 2 interactive + 1 batch + 1 deliver workers plus a 30s reaper tick. First handler: `deliver.telegram` through the existing `Channels`. The 2s inline timeout that demotes a mis-declared `Fast` verb. `/jobs`, `/job`, `/cancel`, `/retry`. | M | **PART SHIPPED** `0e7e0c8` — runtime, lanes, reaper, supervisor, `deliver.telegram`. Missing: the 2s inline demote, `/jobs` `/job` `/cancel` `/retry` |
| **D2′** | **The scheduler, and the existing loops move on.** `schedule.tick` scans `schedules` for due entities and enqueues; `digest.daily:<day>` and `snapshot.networth:<bucket>` get bucketed idempotency keys, so calling the tick every 30 seconds all day produces exactly one job — the unique index *is* the "did I already run today" flag. `notify.alert` gives outbound alerts real retries. | M | **SHIPPED** `486ab56` · `599c8c5` · `91f90cc` — digest, snapshot, `schedule.tick` and alert delivery are all jobs |
| **D3′** | **Web visibility.** `/api/jobs`, `/api/jobs/{id}`, retry, cancel, and `/api/jobs/stats` carrying claim latency, `SQLITE_BUSY` count and oldest-queued age — the three numbers that later decide the Postgres question. A `Jobs` panel and `api-job-repository.ts`. **A new namespace, deliberately: no gated response grows a field.** | M | **PART SHIPPED** `a1a052b` — `/api/jobs` and the panel. Missing: `/{id}`, retry, cancel, `/stats` |
| **D4′** | **Knowledge, calendar and web over MCP.** `knowledge_list` (paths and frontmatter, never bodies), `knowledge_read`, `knowledge_append` onto the append-only `/log` path — **no `knowledge_write` in v1**, because overwriting `persona.md` is a `PUT` that git-commits over the previous content. `calendar_list` and `calendar_create_event` (`Capability::Reach`). `search_web`. The twelve browser workflows in `src/core/ai/tools/` ported onto the MCP `prompts/` surface beside `long_term_review`, where they cost the model nothing in its tool budget. | L | NOT STARTED — blocked by C2 |

**Correction.** An earlier draft of this document called the digest path a bug: *"`maybe_digest`
swallows the error and the day key is only written on success."* That reading was backwards. The day
key is stamped **only on a delivered brief on purpose**, and that is exactly what makes it retry on
the next tick — a short outage costs nothing.

The real limitation is narrower: `digest_due` gates on `digest_hour == Some(now_hour)`, so the
retrying stops when the clock leaves the hour. An outage that outlasts 08:00 loses the day silently.

Shipped as a day-keyed job, that stops being true — and the number that makes it true is
`ATTEMPTS = 12`, not the default 5. Five attempts at the standard backoff spans about 150 seconds,
so a naive move would have replaced an hour of trying with two and a half minutes of it. Twelve
spans 5770s, a little over an hour and a half.

### Stage E — Think (the model arrives, last and behind a flag)

| # | Item | Size | Status |
|---|---|---|---|
| **E1** | **`lyra-agent`.** One OpenAI-compatible client mirroring `ai-client.ts`'s config shape, so `LYRA_AI_ENDPOINT` / `LYRA_AI_MODEL` / `LYRA_AI_KEY` serve Ollama, Groq, OpenAI or Gemini with no code change. An agent loop whose tool surface is `lyra_mcp::tools::registry()` called **in-process**, so the read-only property is inherited rather than re-argued. | L | **DECISION-BLOCKED (D2)**, blocked by D1' |
| **E2** | **The intent front-end and the LLM handlers.** `Proposal` validated against the verb registry before dispatch; additive proposals execute and restate what was understood; mutating proposals confirm; destructive is refused outright. Handlers `ask.llm` and `capture.classify`. Every path degrades to the grammar on timeout, failure or absent config. | M | **DECISION-BLOCKED (D2)**, blocked by E1 |
| **E3** | **Profiles, the distribution seam, and the closing docs.** `LYRA_MCP_DOMAINS=life,wealth` filtering the registry at boot, with its test. `POST /api/jobs/claim|heartbeat|complete|fail` over the same `Queue` trait, so an OOMing model worker stops being able to take the API down. `docs/jobs.md` from merged code; `docs/mcp.md` extended with the shipped write surface. | S | DECISION-INDEPENDENT, blocked by D3', E2 |

`capture.classify` is deliberately separate from `capture`: the note is **saved instantly** and
enriched later, because capture must never depend on a model being up.

### What has actually shipped, and the one thing it changed

Stage A is done, Stage B is two thirds done, and two Stage D items are half done. The **Agents
page** — a live fleet view over a WebSocket, with the queue beside it — is not on this roadmap at
all; it was asked for afterwards and it landed (`6f18abb`, `a1a052b`).

**The thing to know: B1 shipped, so D1 has been answered in one direction already.** The capability
model is in place, `LYRA_MCP_WRITE` defaults off, and the seven life tools are all
`Capability::Read`. But the *strict* original assertion — "exactly one tool writes, and it is
`save_analysis`" — was deliberately kept **alongside** the narrowed one, so it still passes today
and will fail the moment a life write tool is added. Adding a `Sign` capability fails the build
rather than a test.

So D1 is no longer a question about reading. It is a question about **writing**, it is still open,
and the tripwire guarantees it cannot be answered by accident.

### The shortest path to a useful assistant

**A1 → A2 → B3 → B4 → C1 → C3.** Six items, no model, no queue, and at the end of it the phone
captures and reports. A3 lands alongside because it is isolated and ships green; B1/B2/C2 are the
MCP half and can run in parallel with a second pair of hands, or wait.

---

## 3. The four decisions

### D1 — How is the MCP read-only guarantee preserved when life-OS writes land?

**Recommendation: one binary, `Capability` + `Domain` on `ToolDef`, writes behind
`LYRA_MCP_WRITE=1` which defaults to off.**

Today's test says *exactly one tool writes*. That sentence is a proxy; what it protects is
on-chain funds, and the real controls are that no signing path exists in the crate, the process
refuses to boot with signer material present, and secrets are scrubbed on egress. A row in the
user's own SQLite file — visible in the UI, undoable with a click — is not in the same blast
radius as a signature. Conflating them means the tripwire fires on every honest change, and a
tripwire that fires constantly gets disabled.

So: keep the guarantee, change what it counts. `Capability` has no `Sign` variant, so the compiler
forbids a signing tool where the old test only noticed one afterwards; the narrowed test asserts
the wealth desk still has exactly one writer and stays true as the life surface grows.

| Option | Cost |
|---|---|
| **One binary, capability-gated, writes opt-in** *(recommended)* | The invariant needs two sentences instead of one, and the narrowing must be argued in the commit message rather than slipped in. |
| Two binaries (`lyra-mcp` + `lyra-mcp-assistant`) | Duplicates the startup guard — the one piece of this crate that must not exist twice — and every shared-crate change now lands in two places. |
| One binary, `LYRA_MCP_READONLY=1` escape hatch | The weakest of the four: writes are on unless you remember, so the thing that boots is not the thing you reasoned about. |
| Drop the invariant, rely on the boot refusal | Gives up a genuinely useful thing to be able to say to a client, for nothing. |

**If you disagree with this one, say so before Stage B starts** — it is the only decision here that
is expensive to reverse once tools are written.

### D2 — Is server-side inference in Phase 1?

**Recommendation: no. Ship the deterministic grammar; land `lyra-agent` last, behind
`LYRA_AI_ENDPOINT`, pointed at local Ollama first.**

The cost argument does not decide this — a parse is pennies a month. What decides it is that the
two failure modes are asymmetric. A grammar that does not understand you says so and costs you a
retype. A model that misunderstands you completes the wrong task, and you find out on Thursday.

Deterministic commands over the entity store are genuinely useful, need no model, and exercise the
entire path. And the offline story is not hypothetical for a box that polls rather than accepting a
webhook precisely because nothing is forwarded to it: an assistant that stops understanding
`/today` because a provider is rate-limiting you is worse than one that never tried.

Ordering it last costs nothing, because the verb registry is the contract. "Jarvis" later is a
better prompt against the same verbs, not a different bot. Turn the flag on in week three against
the Ollama endpoint already in your config and judge it against the grammar you will still have.

**On where it runs, when it runs: local Ollama, 7–8B instruct, no hosted fallback until you have
felt the latency.** The preset `llama3.2:1b` is too small for reliable JSON-constrained verb
selection. Sending your inbox to a third party to decide whether a line is a task is the one thing
in this design that contradicts why the box exists. Adding the fallback later is one environment
variable; un-sending your data is not.

### D3 — Does every command go through the queue?

**Recommendation: no. Fast verbs answer inline with a hard 2s timeout that demotes them to the
queue; only `Cost::Slow` enqueues.**

`/today` answering in one message is most of what makes this feel like an assistant rather than a
ticketing system, so uniform enqueueing gives up the main thing for a uniformity nobody but the
maintainer benefits from.

The hybrid's risk is concrete and already present: `handle().await` runs inside the poll loop, so
one verb that mis-declares itself `Fast` stalls every command behind it and eats the 25s long poll.
The timeout makes that mistake cost one delayed answer instead of a wedged bot, for about a dozen
lines. Set the budget at 2s and let the first `/digest` that trips it tell you, in the log, that its
`cost()` is wrong.

The replay-safety the queue would have bought for capture is bought more cheaply by minting the
entity id from the Telegram `update_id` — the re-run becomes an `INSERT OR IGNORE` that does
nothing.

### D4 — May the assistant destroy data?

**Recommendation: nothing deletes in phase 1. Archiving is the delete, and only a human can
archive.**

No MCP tool named `delete`/`remove`/`purge`, which keeps `destructiveHint: false` true for the
entire registry — currently asserted for every tool, and a genuinely useful thing to be able to
promise a client. `entity_update(status: "archived")` is what the UI already treats as gone.
Telegram gets `/archive` behind a confirmation; a true `/delete` waits for the audit trail in C1 to
have proved itself.

The cost is real: a mistyped task lingers as an archived row. That is cheap next to a model that
can permanently remove a year of notes because a forwarded message was ambiguous — and note that
once Telegram can create entities from forwarded text, **prompt injection has a write primitive for
the first time**. The chat-id pin limits who can inject; the audit table is what makes it
recoverable rather than prevented.

---

### Two smaller calls I have already defaulted — say the word to flip either

- **The three dead docs — settled 2026-09-25: they went.** `openclaw-integration.md` and
  `roadmap.md` were deleted, along with `productivity-features.md`, `improvements.md` and
  `ai-layer.md`; `modules.md` stayed, because its subject is still real. `git log` keeps all five.
  The multi-channel ambition the OpenClaw document was the only record of is now a paragraph in
  `docs/telegram.md`, which is where anyone would look for it.
- **Two changelogs.** `CHANGELOG.md` had stopped at 1.3.0 while `src/lib/changelog-data.ts` runs to
  2.5.0 and ships inside the app. I have hand-written the catch-up. The permanent fix is to
  **generate `CHANGELOG.md` from `changelog-data.ts`** — roughly thirty lines, and it removes the
  failure mode rather than repairing it. Both files are load-bearing for different readers, which is
  exactly why hand-maintaining both produced the drift.

---

## 4. The risks worth carrying forward

- **The write-lock rule is the one that will bite.** A handler that holds a transaction across a
  model call blocks every writer on the box for the duration — including `/api/entities` POSTs,
  which exhaust the 5s `busy_timeout` and return 500s to the web app. The symptom looks like "the
  app broke"; the cause is in a worker. It needs a doc comment on `JobCtx` and a test.
- **The lease reaper is the single point of recovery for hard kills**, and it is the path never
  exercised in normal operation. It needs its own test: claim, never heartbeat, advance an injected
  clock, assert the job returns to `queued`, and assert the original worker's late `complete()` is
  rejected by the `worker = ?` guard.
- **`ON CONFLICT(idempotency_key) DO NOTHING` is a parse error against a *partial* unique index.**
  The conflict target must repeat the index's `WHERE idempotency_key IS NOT NULL`. Review will not
  catch this; only running it will.
- **The forbidden-substring test is a landmine for life-OS wording.** `sign` matches "assigned",
  "assignee" and "design"; the scan runs over the whole lowercased schema including descriptions.
  Fix it deliberately in B1, before any life tool exists, so the change is obviously about matching
  and not about smuggling something past it.
- **Two id conventions in one table.** `entity_create` mints a UUID; `POST /api/entities` requires a
  client-supplied id. Survivable, but it must be documented or someone will later add a uniqueness
  assumption that holds for one writer and not the other.
- **A mis-scoped owner fails invisibly.** A write under an id absent from `users` succeeds, returns
  cheerfully, and never appears in the web app, because every list query filters on `ownerId`.
  Resolve at boot, degrade to read-only, and have the first write of a session read itself back.
- **Stale numbered handles complete the wrong task.** `/done 3` after a new list, or forty minutes
  later, means something else. Thirty-minute expiry, cleared whenever a new list is issued, every
  mutation echoes the title it acted on, and `/undo` is one word.
- **Timezone.** `digest::day_key` is process-local. If the box runs UTC and you do not, "today" on
  the phone and "today" in the brief disagree for part of every day, and `/done` lands on the wrong
  date near midnight. Decide the process TZ deliberately rather than inheriting it.
- **The owner gate becomes load-bearing twice over.** It is currently the only thing between a
  stranger's message and a portfolio read; after Stage C it is the only thing between a stranger and
  your task list. It is correct today, and it needs a test asserting `handle` is never called for a
  non-owner chat — the current tests cover `message_of` and `command_of` but not the gate itself.
- **Tool count grows fastest right after the surface ships**, when each new tool feels individually
  cheap. Land the `LYRA_MCP_DOMAINS` filter in the same release as the tools, or 28 becomes 40
  within a month and choice quality degrades before anyone measures it.
- **Four worker tasks against `max_connections(8)`** leaves four for the HTTP server. Raise it to
  ~16, or have workers hold a connection only around the claim.
- **The lint budget is exactly 59 problems, all pre-existing.** A Jobs panel that adds one moves a
  gate that currently means something.

---

## 5. When SQLite stops being the right answer

Not from throughput. WAL plus a single-statement claim handles on the order of 10–100 claims a
second on this hardware; a personal assistant will do hundreds of jobs a *day*. The real triggers,
in the order they will actually be hit:

1. **A second machine.** The queue is a file, and SQLite's locking is not safe over a network
   filesystem. This is first, most likely, and has nothing to do with load. The answer before
   Postgres is the HTTP claim API in E3 — same SQL underneath, process isolation on top.
2. **Write-lock contention from long handlers.** Shows up as `SQLITE_BUSY` and 500s from unrelated
   routes. Usually a handler-discipline bug, not a store limit.
3. **Push instead of poll.** The claim loop's latency floor is its idle sleep. An in-process
   `tokio::sync::Notify` poked by the enqueue path removes it for same-process work.

Instrument the seam so the decision is a number, not a feeling: `/api/jobs/stats` carries claim
latency, `SQLITE_BUSY` count and oldest-queued age from D3' onward. *"Move when `SQLITE_BUSY` is
non-zero on a normal day, or when a worker must live elsewhere"* is decidable. *"It feels slow"* is
not.

And there is one thing SQLite does here that a dedicated queue cannot: because the queue and the
application state are the same file, *"mark the parent done and enqueue the reply"* is **one
commit**. With Redis or SQS that is the transactional outbox pattern and a page of machinery. That
is the strongest argument for staying put well past the point where throughput stops being the
reason — and it is why the reply leg is a separate job. If the send lived inside `ask.llm`, a
Telegram outage would retry the *model call*: minutes of compute to re-send one message.
