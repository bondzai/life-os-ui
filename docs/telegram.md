# Telegram — the assistant's front door

Telegram is the only way to reach Lyra from outside the house. It is two halves: `lyra-alerts`
**pushes** alerts and the daily brief out, and `lyra-api/src/tgbot.rs` **pulls** commands in. They
share a process, and since the job queue landed they share the queue: the brief goes out as a
`digest.daily` job and a slow command's late answer as a `deliver.telegram` job, so a Telegram outage
costs a retry rather than the message.

> **`tgbot.rs::sections()` is the authoritative command list.** It joins three fixed
> `&[(&str, &str)]` arrays — `bot_life::COMMANDS`, `bot_jobs::COMMANDS` and `tgbot::COMMANDS` — so
> adding a command is a code change, not configuration. `help()` and the phone's "/" menu are both
> built from it, and a test fails if two sections claim the same name, which would silently shadow
> one of them in `handle()`.

This document absorbs the section that lived in [`docs/api-server.md`](./api-server.md), because the
bot stopped being an implementation detail of an HTTP server the moment it became the plan.

---

## 1. What it does today

Eighteen commands in three sections, **sixteen of them reads**:

**Your money** — eleven, all portfolio reads, in `tgbot.rs`:

`/nw` `/tiers` `/positions` `/rewards` `/risk` `/sats` `/bots` `/market` `/digest` `/status`
`/help`

**Your day** — four, all reads, in `bot_life.rs`. Every reply is sized for a lock screen: six rows
and then a count, because a message you have to scroll on a phone is one you deal with later, at
which point the bot has bought you nothing.

`/today` `/next` `/inbox` `/week`

**The queue** — three, in `bot_jobs.rs`, and **two of them write**:

`/jobs` `/retry <id>` `/cancel <id>`

`/retry` and `/cancel` are the only commands that change anything, and what they change is a row in
`jobs` — never an entity. A job id is a UUID, so `/jobs` shows the first six characters and the other
two accept any unambiguous prefix; an ambiguous prefix is refused rather than guessed, because
retrying the wrong job sends a message you did not mean to send.

All eighteen are published to Telegram with `setMyCommands` at startup so the "/" menu offers them —
without that the bot looks inert even while it is listening, and for a while only the money commands
were published, so the life and queue commands answered when typed but nothing ever suggested them.
`/start` and `/menu` also answer, with the help text; they are aliases rather than entries.

Anything that is not a known command is read as **capture**: `!buy milk`, `/bug the thing`, or a bare
sentence, parsed by `grammar.rs` with the web app's own grammar so a line that works in ⌘K works
here. **It echoes and writes nothing** — the point of this stage is that you can judge the parse,
especially the dates, before it is allowed to change anything.

## 2. Why it polls

Long polling (`getUpdates`, 25s), not a webhook. A webhook needs a public HTTPS endpoint, and the
whole point of this box is that it sits behind a home router with nothing forwarded to it. The
cost is a request every 25 seconds forever; the benefit is that the attack surface is outbound
only.

**Do not call `getUpdates` by hand while the bot is running.** Telegram allows one consumer, and a
manual call consumes the update the bot was waiting for — the message then never reaches it.

## 3. Only the owner is answered

**Every update is checked against the pinned `TELEGRAM_CHAT_ID` before anything runs.** A bot token
is a URL anyone holding it can message; the chat id is what makes the bot *yours*. Anything from
another chat is counted and dropped — never answered, because a reply confirms the bot exists, and
never echoed, because that would put a stranger's text in front of the owner.

Position names are attacker-controlled on-chain data, so every label is stripped of control
characters and capped before it goes into a message.

### This is already an authorization boundary, not only a spam filter

It stopped being a spam filter when `/cancel` shipped. The gate is now the only thing between a
stranger's message and a queued job being dropped, or a failed one being run again — and it is the
only thing between a stranger and your agenda, which `/today` and `/week` read out. It is still not
the only thing between a stranger and an *entity*: nothing over Telegram writes one. The first
command that does makes this line of code the only thing between a forwarded message and a row whose
title the model reads back on the next agenda call.

The gate is correct as written. What it lacks is a test asserting `handle` is never called for a
non-owner chat: the current tests cover `message_of` and `command_of` but not the gate itself,
which is the one thing here that must never regress. See
[`docs/assistant-roadmap.md` §4](./assistant-roadmap.md).

## 4. Restart-safe, and rate-limited on the way back

The update offset is acknowledged **after** the reply is sent and stored in `alert_state` under
`tgbot:offset`, so a restart mid-command re-runs at most that one command rather than replaying the
backlog. This is the correct at-least-once choice, and the two commands that write are built to
survive it: `/retry` enqueues the copy under the key `retry:<job id>`, so a second one returns the
job the first made and answers "Already retrying", and a second `/cancel` finds the job already
cancelled and says so. Neither can produce a duplicate. The first command that inserts an *entity*
has to earn the same property — which is why the roadmap mints entity ids from the Telegram
`update_id`, making the re-run an insert that does nothing.

`MAX_PER_POLL = 5` caps how many commands one poll may run. After an outage Telegram hands back
everything queued at once, and a week offline should not fire a week of portfolio reads back to
back.

## 5. Two hazards already paid for

### A malformed URL fails exactly like an outage

The first version of `poll` built its URL with a `\`-continuation and shipped nine literal spaces
in the path — `getUpdates%20%20%20…?timeout=`. Every poll failed for a day while messages queued
unread, and the log said `error sending request`, which is what a network problem says too. The URL
is built by `updates_url`, on one line, with a test asserting it contains no space and that the
query starts immediately after the method name.

### The token was in the logs

`reqwest::Error` renders the URL it failed on, and that URL carries the bot token — so every
transient blip wrote the secret into `~/Library/Logs/lyra/server.log` in plain text. Both call
sites now log `e.without_url()`. **If a log from before 2026-08-23 was ever copied off this
machine, rotate the token with @BotFather.**

## 6. Two limits that were live bugs, and what closed each

- **4096 characters.** Telegram rejects anything longer outright, and the rejection surfaced only as
  `delivered = false` in a log line — so the daily brief, which `digest.rs` assembles from every
  module, could simply vanish on a long day. `split_for_telegram` in
  `lyra-alerts/src/telegram.rs` now splits anything over the limit: on blank lines first, then single
  newlines, then — only if one line is somehow longer than the whole limit — on characters. The order
  is the point. A digest broken between sections reads as two messages; the same digest broken
  mid-number reads as a bug. Anything that already fits returns one part, so the overwhelming
  majority of sends allocate one string and make one request exactly as before.
- **The poll loop's budget.** `handle().await` used to run inside the loop, so `/nw` or `/digest` — a
  full portfolio read across several chains and an exchange — held it for as long as the upstreams
  took, and the 25-second long poll behind it was spent waiting. A command now gets
  `INLINE_BUDGET = 2s`, which is long enough that `/today` and `/help` still answer in one message.
  Past it the loop replies *"Working on /nw — the answer will follow here"* and moves on. **The work
  is not abandoned at the deadline**: dropping it and starting again on the queue would do a slow
  portfolio read twice, so the task keeps running and its answer is enqueued as a `deliver.telegram`
  job — which means the part that depends on Telegram being up gets retries. The computation itself
  is not durable, so a restart while it runs loses the answer; but you were already told it was
  coming, so the cost is asking again rather than silence.

## 7. The server cannot call a model

**100% of Lyra's inference happens in the browser** (`src/core/ai/ai-client.ts:33`). There is no
server-side model client and nowhere for a model key to live in this process.

So a command that needs natural language — *"what should I do today?"* — cannot be served at all
today, however the command table grows. This is the single hardest constraint on "command it from
Telegram", and it is the reason the roadmap treats deterministic commands as Phase 1 and inference
as a flag-gated last phase. See [D2](./assistant-roadmap.md).

## 8. Replies are plain text on purpose

Bot replies are built from on-chain names and used to go out with `parse_mode: Markdown` set. One
`*` in a pool name and Telegram rejects the whole request with `can't parse entities`, so the reply
is silently never delivered.

A `Message` now says whether its text is already marked up: `Message::plain` is escaped by whoever
sends it, `Message::telegram_markup` is passed through. Escaping **strips** rather than
backslash-escapes, because removal cannot produce an unbalanced entity, and a dropped `*` costs a
glyph where a rejected message costs the whole alert. See [`docs/alerts.md`](./alerts.md).

The command bot keeps its own concrete `TelegramSender` rather than going through `Channels`: its
replies go back to the chat that asked, which is not a fan-out.

## 9. Configuration

| Variable | What it does |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Unset, the bot never starts — logged as *"telegram command bot idle"*, which is the ordinary un-set-up state, not a failure |
| `TELEGRAM_CHAT_ID` | The only chat answered. Also where alerts go |
| `TELEGRAM_OWNER_USER_ID` | The row in `users` whose life `/today` and the rest read — **not** the chat id. Unset, the owner is resolved as the only user there is; unresolvable, the money commands still answer and the life commands decline with the name of this variable |

The first two are also read by the alert sender; see [Deployment §7.1](./deployment.md).

## 10. What it becomes

Most of what this section used to describe as future is merged. `/today` `/next` `/inbox` `/week`
answer now, so do `/jobs` `/retry` `/cancel`, and a slow command already answers later in the same
chat — see §1 and §6 for both. The capture grammar is ported and shares its table with the web app's.

Three things have not landed, and they are what is left of the plan:

- **Capture cannot write.** `!call the accountant tomorrow @Accounts` tells you what it would create
  and creates nothing. That echo is the whole of the distance between this bot and filing a task with
  one thumb, and it is deliberate: the parse, especially the dates, has to be judged before it is
  given the power to change anything.
- **There is no `/p`.** Projects have a page and no command.
- **The command surface is three hand-written arrays, not one verb registry shared with `lyra-mcp`.**
  A new verb is therefore added twice, in two shapes, and the two can disagree about what exists —
  `sections()` only guarantees the three Telegram arrays agree with each other.

See [`docs/assistant-roadmap.md`](./assistant-roadmap.md).

## See also

- [`docs/assistant-roadmap.md`](./assistant-roadmap.md) — the plan and its four decisions
- [`docs/jobs.md`](./jobs.md) — the queue `/jobs` reads and a late answer goes out through
- [`docs/alerts.md`](./alerts.md) — the outbound half, and Discord
- [`docs/api-server.md`](./api-server.md) — the process this runs inside
