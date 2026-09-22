# Telegram — the assistant's front door

Telegram is the only way to reach Lyra from outside the house. It is two halves that share a
process and nothing else: `lyra-alerts` **pushes** alerts and the daily brief out, and
`lyra-api/src/tgbot.rs` **pulls** commands in.

> **`core/crates/lyra-api/src/tgbot.rs:47` is the authoritative command list.** It is a fixed
> `&[(&str, &str)]` array — adding a command is a code change, not configuration.

This document absorbs the section that lived at `docs/api-server.md:140`, because the bot stopped
being an implementation detail of an HTTP server the moment it became the plan.

---

## 1. What it does today

Eleven commands, **all of them portfolio reads**:

`/nw` `/tiers` `/positions` `/rewards` `/risk` `/sats` `/bots` `/market` `/digest` `/status`
`/help`

They are published to Telegram with `setMyCommands` at startup so the "/" menu offers them —
without that the bot looks inert even while it is listening.

Nothing it can do changes a row. That is the property every section below is about keeping honest
as it stops being true.

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

### This is a spam filter today and an authorization boundary tomorrow

Right now the gate is the only thing between a stranger's message and a portfolio *read*. The first
time a command writes a row, the same line of code becomes the only thing between a stranger and
your task list — and after that, between a forwarded message and an entity whose title the model
will read back on the next agenda call.

The gate is correct as written. What it lacks is a test asserting `handle` is never called for a
non-owner chat: the current tests cover `message_of` and `command_of` but not the gate itself,
which is the one thing here that must never regress. See
[`docs/assistant-roadmap.md` §4](./assistant-roadmap.md).

## 4. Restart-safe, and rate-limited on the way back

The update offset is acknowledged **after** the reply is sent and stored in `alert_state` under
`tgbot:offset`, so a restart mid-command re-runs at most that one command rather than replaying the
backlog. This is the correct at-least-once choice, and it is harmless while every command is a
read. The moment one writes, a replay is a duplicate row — which is why the roadmap mints entity
ids from the Telegram `update_id`, making the re-run an insert that does nothing.

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

## 6. Two limits that are live bugs, not future work

- **4096 characters.** Telegram rejects anything longer outright, and the rejection surfaces only
  as `delivered = false` in a log line. `digest.rs` is 1066 lines of string building pointed at a
  single `sendMessage`. Chunking on line boundaries is the first item in the roadmap for exactly
  this reason.
- **The poll loop is serial and unbudgeted.** `handle().await` runs inside it, so one slow command
  delays every command behind it and can push past the 25s long poll. Adding commands that touch
  more tables makes this likelier, not less.

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

Both are also read by the alert sender; see [Deployment §7.1](./deployment.md).

## 10. What it becomes

The roadmap's Stage B and C turn the fixed command array into a verb registry that MCP and the job
queue share, add `/today` `/next` `/inbox` `/p` `/week`, and then a capture grammar so
`!call the accountant tomorrow @Accounts` is one thumb. Stage D adds `/jobs` and the ability for a
slow command to answer later in the same chat.

When that lands, this section says which commands enqueue rather than answer inline, and what the
user sees while a job is pending. It does not say that yet, because none of it is merged.

## See also

- [`docs/assistant-roadmap.md`](./assistant-roadmap.md) — the plan and its four decisions
- [`docs/alerts.md`](./alerts.md) — the outbound half, and Discord
- [`docs/api-server.md`](./api-server.md) — the process this runs inside
