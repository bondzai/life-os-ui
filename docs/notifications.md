# Notifications

Every message Lyra sends you belongs to a **group**, and a group is **routed** to channels. A channel
is one destination — a Discord room, a Telegram chat. That replaces the only policy the environment
could express, which was "everything configured receives everything".

Configured from **Settings → Notifications**. The tables are `channels` and `routes` (migration v8);
delivery is the `notify.deliver` job.

## The groups

| Group | Kinds | Why together |
|---|---|---|
| `money` | out-of-range, back-in-range, fees ready, health factor | Time-sensitive, about real positions |
| `day` | the daily brief, the habits nudge, your own schedules | Scheduled and expected. The only group where quiet hours are the point |
| `system` | dead-lettered jobs; deploys and restarts are not wired yet | About the box rather than about you |

Groups are declared in `notify::GROUPS`, and the HTTP layer refuses a route to a group not on that
list rather than storing one nothing would ever deliver to.

## Severity

`info` / `warning` / `critical`. A route carries its level **and above**, so `warning+` on your phone
and `info+` in a Discord room is the usual arrangement.

`notify::severity_of` maps an alert to a level, and only **`HealthFactorLow` is critical** — because
critical is the only level that pierces quiet hours. Approaching liquidation is the one thing worth
waking for; a position leaving its range is not.

An unrecognised severity reads as `info` rather than being refused. Not delivering something because
its level was misspelled is worse than delivering it quietly.

## Quiet hours

Local hours on a route, and the range **wraps**: `22`–`7` is the evening and the small hours, which is
the only way anyone wants to write it. Local because "do not wake me" is a wall-clock idea. A route
with one bound set and not the other is treated as having none — half a range is a half-finished edit,
not an instruction.

## One job per channel

`notify::notify` resolves the destinations and queues **one `notify.deliver` job per channel**. Each
gets its own backoff, its own dead letter, and writes its own health onto the channel row.

That split is the fix for a real bug rather than a tidiness preference. `Channels::send` reports
success when **any** channel took the message, so a Telegram success used to mask a Discord failure
entirely — the job completed, and the only trace was a `tracing::warn`. With one job and one `"sent"`
effect there were only two options and both lost: drop the failure, or retry and re-send to the
channel that already succeeded. Separate jobs make the question go away.

`deliver.telegram` still exists and still covers every configured channel in one job, now with an
effect per channel so a retry only attempts the ones still owed it. It is the fallback path below.

## The fallback, and when to remove it

**If routing resolves to nothing, the message goes to every configured channel instead**, and the log
says so.

This is transitional and deliberate. The box was already sending real alerts about real money before
any of this existed, and it has no channels and no routes until somebody opens Settings. Routing
correctly to nowhere would have been a silent stop to every alert — the exact failure the feature was
built to remove.

The cost: **"I route nothing here on purpose" cannot yet be said.** It reads as "not configured".
That is the right trade while the tables are empty and the wrong one once they are not. Three tests
pin the behaviour so removing it is a decision rather than a regression — search for
`falls_back_rather_than_disappearing`.

The fallback job carries the caller's idempotency key. It did not at first, which meant a caller
asking for exactly-once got it on the routed path and silently not on this one — two paths disagreeing
about whether a repeat is a repeat. Callers that want every copy, like the range alerts, pass no key
and are unaffected.

## The credential

A Discord webhook URL *is* the credential: its last path segment is a token, and anyone holding the
URL can post to that room.

- **Sealed at rest.** AES-256-GCM, key from `LYRA_SECRET_KEY`, via `lyra_db::secrets`. Before this,
  no credential was in the database at all — which is exactly why the nightly `VACUUM INTO` backups
  could go offsite without a thought. Stored in the clear, fourteen nightly files and the offsite copy
  would each have become a live credential, silently. **Set the key or the UI refuses to store a
  webhook**, by name; it never falls back to plaintext.
- **The channel id is the AAD**, so a sealed secret cannot be copied between rows — unsealing under a
  different id fails rather than posting one room's message to another room's webhook.
- **Never returned.** A channel comes back with a preview — host, webhook id, last four characters —
  and `stored_secret`. The one door is `ChannelStore::secret_of`, named so the call site reads as what
  it is. Tests at both layers serialize every read path and fail if the token appears.
- **Write-only in the UI.** The field is always empty, because the screen was never given the value.
  Absence on a `PATCH` therefore means "leave it alone", which is the only way it can be said.

This protects a database copy leaving the box, not someone who has the box: the key is on the same
machine, in a file the service reads. Copies of the database leave routinely and by design; that is
the threat being addressed.

## Validating a URL

`Transport::check` owns the rules and asks `Webhook::new`, which refused every host but
`discord.com` — and plaintext, and the legacy `discordapp.com` — long before any of this was
configurable. **Making the URL editable is not the same as making it unconstrained.** A UI that
accepted any URL would have undone a guard this repo already had, with a test already explaining why:
the value is posted to verbatim, so an arbitrary host is a credential handed away.

Refusals name the rule rather than saying "invalid", because a pasted webhook is usually right and the
mistake is usually specific — the wrong domain, or `http` from an old note.

Two more things follow from the URL being input rather than something you typed into a file:

- **Redirects are refused** (`redirect::Policy::none()`). The host is checked once, at write time;
  without this the host finally posted to is wherever the redirect chain ends, and a home network is
  on the other side. *Not covered by a test* — that needs a server that redirects.
- **The check runs again at send time.** A row can outlive the rules that admitted it, and the send
  path is the code actually handing the credential over.

## The daily brief

The brief is built once and delivered per channel, and the rule that matters is unchanged: **the delta
baseline advances only once somebody has received it.** A brief nobody got must not consume the changes
it would have shown.

`build_digest` and `advance_digest_snapshot` are now separate, which reads like it weakens that rule
and does the opposite. The built text and the new baseline are recorded as a job step, so a retry an
hour later sends *the brief that was built at 08:00* rather than rebuilding it against a portfolio
that has since moved. The baseline advances when **at least one** channel has taken it — the old
meaning of "sent" — while the channels still owed it keep retrying on their own.

The on-demand `/api/wealth/alerts/digest` endpoint still uses the whole fan-out in one call, because a
button press wants an answer rather than a queue.

## Schedules

**Settings → Schedules** is a table of things Lyra does on its own. Tables are `crons` (migration v9);
the tick is `crons::run_due`, called from `alert_loop` on the same thirty-second beat as the alert
sweep. A schedule decides *when* and *what*; the routing above decides *where*.

### Not a cron string

The schedule is a tagged union — `daily` / `weekly` / `every` — so the form renders it without a
parser and there is nothing to mis-type. That matters more here than elsewhere: a wrong
`30 7 * * 1-5` fails by **a message silently never arriving**, which is the one failure a schedule
cannot have.

`Schedule::validate` refuses one that could never fire as written — a weekly with no days, or an
`every` shorter than a minute, which the thirty-second tick could not honour anyway — and the refusal
names the rule rather than saying "invalid".

### The occurrence is the name of a firing

A due schedule becomes a job keyed `<action>:<cron id>:<occurrence>`, where the occurrence is its
**scheduled** time — `2026-09-27T09:30` — not the moment the tick noticed. The tick runs every thirty
seconds, so every tick inside the window produces the same key and the queue's partial unique index
turns all but the first into a no-op. Exactly-once needs no new machinery: it is the same mechanism
the daily brief has always used.

`last_occurrence` is what stops a fired slot firing again. Changing a schedule clears it, because the
old occurrence is not a statement about the new times.

### A missed firing is counted, not dropped

If the box was off past `catch_up_minutes`, the slot is recorded as **missed** — once, not once per
tick — and shown on the row. Silently skipping it is what makes a schedule that has stopped look like
one that is working, and the `missed` column exists for exactly that.

The default catch-up is an hour: long enough that a reboot does not lose the morning, short enough
that a nudge does not turn up at lunchtime. Zero means "only on time".

### Run now does not use up the day

The **Run now** button keys its job `manual:<epoch>` and does not touch `last_occurrence`, so pressing
it while testing still leaves the real firing to happen. A button that consumed the morning brief to
prove the morning brief works would be worse than no button.

### The action is an allowlist

`crons::ACTIONS` holds two, and it is checked on write. "Any registered job kind" was the other
option and is the worse one: a kind that exists is not necessarily one that makes sense on a timer,
and a cron pointed at the wrong one produces jobs that fail forever.

| Action | What it does |
|---|---|
| `notify.message` | Sends text you wrote. Needs a message and a group. |
| `wealth.defi` | **Reads the chains**, then reports positions and unclaimed rewards. Takes no payload — there is nothing for a person to get wrong. |

That split is the whole difference between the two: one sends what you typed, the other goes and
finds out. The Settings form follows it — choosing an action that fetches hides the message field,
because requiring a message for it would make the form unsubmittable.

`wealth.defi` runs on `Lane::Batch`, not `Deliver`: building a wallet is several seconds of RPC
across every chain, and a delivery worker blocked on that is a Telegram reply nobody gets. It
routes to the **`money`** group at `info` — a scheduled read is not an alert, and the alert rules
are what decide something is wrong.

It reports how many chains it could **not** read. A provider rate-limiting you otherwise shows up
as a total that quietly shrank, which reads as having lost money.

### How an action sends


`crons::ACTIONS` holds one entry, `notify.message`, and it is checked on write. "Any registered job
kind" was the other option and is the worse one: a kind that exists is not necessarily one that makes
sense on a timer, and a cron pointed at the wrong one produces jobs that fail forever. Adding one is a
line in that array, deliberately.

`notify.message` is a **producer**: it resolves the routing and enqueues one `notify.deliver` follow-up
per channel rather than sending inline, so a partial delivery retries per channel like everything else.

### Not the built-in three

The brief, the habits nudge and the net-worth snapshot are **not** rows in this table. They still read
their hours from the environment. Migrating them is a separate deliberate change, because they carry
the morning brief and moving them in the same breath as introducing the machinery would mean a bug
here is a brief that never arrives.

## When the queue gives up

`system`'s first producer. `dead_letters::report` runs last on the sweep's tick and sends one message
for whatever the queue has set aside since the previous one, grouped by kind:

```
3 jobs were set aside after failing.

wealth.snapshot ×2 — kucoin: 401 Unauthorized
digest.daily — telegram: connection timed out

They are kept as evidence — retry or discard them on the Jobs page.
```

**A dead delivery job is never reported.** The report is itself a delivery job, so reporting a dead
`notify.deliver` would send the news down the path that just failed, die the same way, and report
*that* — one failure becoming an unbounded chain. The delivery kinds are named in
`dead_letters::SILENT` and marked without a message. That loses nothing: a failing channel already
carries its `last_error` and `failing_since` on its own row, which is what the channels list shows.

Severity is `warning` and never `critical`: a job that failed at 3am is not worth waking for, and
critical is the level that pierces quiet hours.

The mechanics — one message per tick however many died, and the `job_effects` mark that makes
"already mentioned" per job rather than per timestamp — are in `docs/jobs.md` §5.

**The first report after deploying this may name several jobs at once**, because the queue keeps dead
rows for fourteen days and nothing has ever reported them. That is a backlog being drained, not a new
fault.

## Settings you need

| | |
|---|---|
| `LYRA_SECRET_KEY` | Seals stored credentials. `openssl rand -base64 32`. Without it the UI refuses to store a webhook |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram's credential stays in the environment — a bot token is stronger than a room webhook and there is only one of it |
| `DISCORD_WEBHOOK_URL` | Still read, still the fallback channel. A UI-configured room does not need it |

## What is not built

- **`system` has one producer, not three.** Dead-lettered jobs report themselves (below). Deploys
  and restarts do not yet, and a restart is the one most worth having: the box rebooting at 4am is
  invisible right now.
- **No in-app notifications.** The frontend `notification-store` is local-only: zustand and
  localStorage, nothing fetches it from the server. An inbox is a store rather than a transport, so it
  is not a `MessageSender` and not a channel.
- **No `notifications` table.** The job row is the history, which the queue already retains for
  fourteen days. A table earns its place when something wants to read notifications back — an in-app
  inbox, or a "what did you send me last week".
- **A generic webhook transport.** Adding a *named* service (ntfy, Slack, Home Assistant) is one
  `MessageSender` and one host check. A literal "post to any URL I type" needs an allowlist, because
  otherwise a settings form is an SSRF console pointed at a home network.
- **Telegram is not seeded as a channel row.** It works through the fallback. Adding it in Settings
  makes it routable.
